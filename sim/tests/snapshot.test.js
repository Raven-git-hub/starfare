'use strict';

// Tests sim/snapshot.js — the developer state inspector's data source.
//
// The point of these tests is ONE tripwire: the snapshot must never disagree
// with the engine's own selectors. If buildSnapshot ever reports a total the
// live state doesn't actually hold, the inspector would quietly lie to the
// human about the economy — so we pin every number in the snapshot to
// computeGalacticSupply / computeOccupancy / getSite and fail loudly on drift.
//
// Uses real seed ids: pl_00001_n02 is a titanium node (same node the demo and
// the occupancy tests seat a mine on).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { computeGalacticSupply } = require('../supply.js');
const { computeOccupancy } = require('../occupancy.js');
const { getSite } = require('../seed.js');
const { buildSnapshot, SNAPSHOT_SCHEMA } = require('../snapshot.js');

// A state with two guilds, real stockpiles, fuel in both the reserve and a
// guild hoard, and one seated titanium mine — enough to exercise every branch.
function sampleState() {
  return createState({
    guilds: [
      {
        id: 'player-guild',
        name: 'Player Guild',
        credits: 120,
        fuelHoard: 4,
        influence: 100,
        homeSystemId: 'sys_0002',
        homePlanetId: 'pl_00004',
        stockpiles: { titanium: 15, lead: 3 },
        ventures: [
          { id: 'mine_1', ownerGuildId: 'player-guild', type: 'mining', siteId: 'pl_00001_n02', resourceType: 'titanium', productionRate: 5 },
        ],
      },
      { id: 'bot_a', name: 'Bot A', isBot: true, credits: 80, fuelHoard: 1, stockpiles: { titanium: 5 } },
    ],
    reserve: { reserveLevel: 30 },
    syndicate: { ledger: -200 },
    claims: [
      { claimId: 'claim_citadel', ownerGuildId: 'syndicate', landmarkId: 'citadel', landmarkKind: 'citadel', claimedAtTick: 0, contested: false },
      { claimId: 'claim_home_player-guild', ownerGuildId: 'player-guild', landmarkId: 'sys_0002', landmarkKind: 'system', claimedAtTick: 0, contested: false },
    ],
  });
}

test('snapshot header echoes schema, tick, and Syndicate ledger', () => {
  const s = sampleState();
  const snap = buildSnapshot(s);
  assert.equal(snap.schemaVersion, SNAPSHOT_SCHEMA);
  assert.equal(snap.tick, s.tick);
  assert.equal(snap.syndicate.ledger, s.syndicate.ledger);
});

test('galactic resource totals equal computeGalacticSupply exactly', () => {
  const s = sampleState();
  const snap = buildSnapshot(s);
  assert.deepEqual(snap.galacticSupply.resources, computeGalacticSupply(s).resources);
});

test('each good total equals the sum of that good across guild stockpiles', () => {
  // The drift tripwire spelled out: the snapshot cannot report a total the
  // guilds do not actually hold between them.
  const s = sampleState();
  const snap = buildSnapshot(s);
  for (const good of Object.keys(snap.galacticSupply.resources)) {
    const summed = s.guilds.reduce((n, g) => n + ((g.stockpiles && g.stockpiles[good]) || 0), 0);
    assert.equal(snap.galacticSupply.resources[good], summed, `total for ${good} drifted`);
  }
});

test('fuel is reported specially: reserve, guildHeld, and their sum', () => {
  const s = sampleState();
  const snap = buildSnapshot(s);
  const supply = computeGalacticSupply(s);
  assert.equal(snap.galacticSupply.fuel.reserve, supply.fuel.reserve); // 30
  assert.equal(snap.galacticSupply.fuel.guildHeld, supply.fuel.guildHeld); // 4 + 1
  assert.equal(
    snap.galacticSupply.fuel.total,
    supply.fuel.reserve + supply.fuel.guildHeld,
  );
});

test('occupancy map equals computeOccupancy', () => {
  const s = sampleState();
  assert.deepEqual(buildSnapshot(s).occupancy, computeOccupancy(s));
});

test('each seated venture carries its seed site resolved by getSite', () => {
  const s = sampleState();
  const snap = buildSnapshot(s);
  const v = snap.ventures.find((x) => x.id === 'mine_1');
  const site = getSite('pl_00001_n02');
  assert.equal(v.siteId, 'pl_00001_n02');
  assert.equal(v.site.kind, site.kind); // 'resource'
  assert.equal(v.site.planetId, site.planetId); // pl_00001
  assert.equal(v.site.resourceType, site.resourceType); // titanium
});

test('guild breakdown copies the shown fields and does not alias live state', () => {
  const s = sampleState();
  const snap = buildSnapshot(s);
  const p = snap.guilds.find((g) => g.id === 'player-guild');
  assert.equal(p.credits, 120);
  assert.equal(p.fuelHoard, 4);
  assert.equal(p.influence, 100);
  assert.equal(p.homeSystemId, 'sys_0002');
  assert.equal(p.homePlanetId, 'pl_00004');
  assert.deepEqual(p.stockpiles, { titanium: 15, lead: 3 });
  // Mutating the snapshot must not reach back into the state's stockpiles.
  p.stockpiles.titanium = 999;
  assert.equal(s.guilds.find((g) => g.id === 'player-guild').stockpiles.titanium, 15);
});

test('claims carry their seed landmark resolved, in order', () => {
  const s = sampleState();
  const snap = buildSnapshot(s);
  assert.equal(snap.claims.length, 2);
  const home = snap.claims.find((c) => c.claimId === 'claim_home_player-guild');
  assert.equal(home.ownerGuildId, 'player-guild');
  assert.equal(home.landmarkId, 'sys_0002');
  assert.equal(home.landmarkKind, 'system');
  assert.ok(home.landmark, 'the home system landmark must resolve');
  assert.equal(home.landmark.kind, 'system');
  const citadel = snap.claims.find((c) => c.claimId === 'claim_citadel');
  assert.equal(citadel.landmark.kind, 'citadel');
});

test('a claim pointing at a missing landmark resolves to null, not a throw', () => {
  const s = createState({
    guilds: [],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [
      { claimId: 'c_bad', ownerGuildId: 'syndicate', landmarkId: 'sys_99999', landmarkKind: 'system', claimedAtTick: 0, contested: false },
    ],
  });
  const snap = buildSnapshot(s);
  assert.equal(snap.claims[0].landmark, null);
});

test('an unseated venture resolves to a null site rather than throwing', () => {
  const s = createState({
    guilds: [
      { id: 'g1', credits: 0, fuelHoard: 0, ventures: [
        { id: 'm1', ownerGuildId: 'g1', type: 'mining', resourceType: 'titanium', productionRate: 5 },
      ] },
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  const v = buildSnapshot(s).ventures.find((x) => x.id === 'm1');
  assert.equal(v.siteId, null);
  assert.equal(v.site, null);
});
