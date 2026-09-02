'use strict';

// Tests the live<->seed wiring for the TERRITORY layer (slice A, 03-08-26):
//   - sim/seed.js's landmark resolvers (citadel / outpost / system + homeworld);
//   - the claim-integrity and guild-home invariants in sim/invariants.js;
//   - foundGuild's home validation + seating in sim/actions.js.
// The home is DERIVED from the seed (home-anchor.js): HOME_SYSTEM is the first
// starter-eligible system, HOME_PLANET its Terran homeworld. sys_0001 exists but
// is NOT starter-eligible (a seed-7331 fact still pinned here, like the 9-outpost
// count); out_01 is a Syndicate outpost; 'citadel' is the origin landmark singleton.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HOME_SYSTEM, HOME_PLANET } = require('./home-anchor.js');

const { createState } = require('../state.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { checkInvariants } = require('../invariants.js');
const { intake, validateAction, createFoundGuildAction } = require('../actions.js');
const seed = require('../seed.js');

function hasRule(state, rule) {
  return checkInvariants(state, 0).some((v) => v.rule.startsWith(rule));
}

// --- seed.js landmark resolvers -------------------------------------------

test('seed landmark resolvers return the real seed features', () => {
  assert.equal(seed.getCitadel().id, 'citadel');
  assert.equal(seed.getOutposts().length, 9); // the generator places 9
  assert.equal(seed.getOutpost('out_01').kind, 'outpost');
  assert.equal(seed.getSystem(HOME_SYSTEM).starterEligible, true);
  assert.equal(seed.isStarterSystem(HOME_SYSTEM), true);
  assert.equal(seed.isStarterSystem('sys_0001'), false); // exists, not starter
  assert.equal(seed.getTerranHomeworld(HOME_SYSTEM), HOME_PLANET);
  assert.equal(seed.getSeedNumber(), 7331);
});

test('getLandmark is strict about kind (an outpost id is not a system)', () => {
  assert.ok(seed.getLandmark('out_01', 'outpost'));
  assert.equal(seed.getLandmark('out_01', 'system'), null);
  assert.equal(seed.getLandmark('citadel', 'outpost'), null);
  assert.equal(seed.getLandmark('sys_99999', 'system'), null);
});

// --- claim integrity -------------------------------------------------------

test('the zero-state\'s Syndicate claims all resolve to real landmarks', () => {
  assert.deepEqual(checkInvariants(createZeroState(), 0), []);
});

function stateWithClaims(claims) {
  return createState({
    guilds: [],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims,
  });
}

test('a claim pointing at a non-existent landmark is caught', () => {
  const s = stateWithClaims([
    { claimId: 'c1', ownerGuildId: 'syndicate', landmarkId: 'sys_99999', landmarkKind: 'system', claimedAtTick: 0, contested: false },
  ]);
  assert.equal(hasRule(s, 'claim-landmark-exists'), true);
});

test('a claim with the wrong landmarkKind is caught (outpost id tagged system)', () => {
  const s = stateWithClaims([
    { claimId: 'c1', ownerGuildId: 'syndicate', landmarkId: 'out_01', landmarkKind: 'system', claimedAtTick: 0, contested: false },
  ]);
  assert.equal(hasRule(s, 'claim-landmark-exists'), true);
});

// --- guild home integrity --------------------------------------------------

function stateWithHome({ homeSystemId, homePlanetId, claim = true }) {
  const claims = claim
    ? [{ claimId: 'claim_home_g1', ownerGuildId: 'g1', landmarkId: homeSystemId, landmarkKind: 'system', claimedAtTick: 0, contested: false }]
    : [];
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, homeSystemId, homePlanetId }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims,
  });
}

test('a correctly seated guild home passes every invariant', () => {
  const s = stateWithHome({ homeSystemId: HOME_SYSTEM, homePlanetId: HOME_PLANET });
  assert.deepEqual(checkInvariants(s, 0), []);
});

test('a homeless guild is legal', () => {
  const s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0 }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  assert.deepEqual(checkInvariants(s, 0), []);
});

test('a home on a non-starter system is caught', () => {
  const s = stateWithHome({ homeSystemId: 'sys_0001', homePlanetId: null });
  assert.equal(hasRule(s, 'home-is-starter-system'), true);
});

test('a homePlanetId that disagrees with the seed homeworld is caught', () => {
  const s = stateWithHome({ homeSystemId: HOME_SYSTEM, homePlanetId: 'pl_99999' });
  assert.equal(hasRule(s, 'home-planet-matches-seed'), true);
});

test('a home with no matching ownership claim is caught', () => {
  const s = stateWithHome({ homeSystemId: HOME_SYSTEM, homePlanetId: HOME_PLANET, claim: false });
  assert.equal(hasRule(s, 'home-claim-exists'), true);
});

// --- foundGuild home validation + seating ----------------------------------

test('createFoundGuildAction requires a homeSystemId', () => {
  assert.throws(() => createFoundGuildAction({ guildId: 'g', credits: 10 }), /homeSystemId is required/);
});

test('founding on a non-starter system is rejected', () => {
  const s = createZeroState();
  const v = validateAction(s, createFoundGuildAction({ guildId: 'g1', credits: 10, homeSystemId: 'sys_0001' }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /not a starter-eligible/);
});

test('founding seats the guild on its homeworld and claims the system', () => {
  const s = createZeroState();
  const { state: next, results } = intake(s, [
    createFoundGuildAction({ guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: HOME_SYSTEM }),
  ]);
  assert.equal(results[0].accepted, true);
  const g = next.guilds[0];
  assert.equal(g.homeSystemId, HOME_SYSTEM);
  assert.equal(g.homePlanetId, HOME_PLANET);
  const home = next.claims.find((c) => c.landmarkId === HOME_SYSTEM && c.ownerGuildId === 'player-guild');
  assert.ok(home);
  assert.equal(home.landmarkKind, 'system');
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('two guilds racing for the same home: first-valid-wins', () => {
  const s = createZeroState();
  const { state: next, results } = intake(s, [
    createFoundGuildAction({ guildId: 'a', credits: 10, homeSystemId: HOME_SYSTEM }),
    createFoundGuildAction({ guildId: 'b', credits: 10, homeSystemId: HOME_SYSTEM }),
  ]);
  assert.equal(results[0].accepted, true);
  assert.equal(results[1].accepted, false);
  assert.match(results[1].reason, /already claimed/);
  assert.equal(next.guilds.length, 1);
  assert.deepEqual(checkInvariants(next, next.tick), []);
});
