'use strict';

// Tests sim/occupancy.js (the derived "what's on this site" map) and the
// site-occupancy invariant in invariants.js (referential integrity between a
// venture's siteId and the static seed). Uses real seed ids: pl_00001_n02 is
// titanium, pl_00001_n01 is lead, pl_00001_s01 is a settlement slot.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { computeOccupancy } = require('../occupancy.js');
const { checkInvariants } = require('../invariants.js');
const { getSite } = require('../seed.js');

function stateWithVentures(ventures) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
}

function hasRule(state, rule) {
  return checkInvariants(state, 0).some((v) => v.rule.startsWith(rule));
}

test('computeOccupancy maps each seated venture to its site; unseated are skipped', () => {
  const s = stateWithVentures([
    { id: 'm1', ownerGuildId: 'g1', type: 'mining', siteId: 'pl_00001_n02', resourceType: 'titanium', productionRate: 1 },
    { id: 'm2', ownerGuildId: 'g1', type: 'mining', resourceType: 'lead', productionRate: 1 }, // unseated
  ]);
  assert.deepEqual(computeOccupancy(s), { pl_00001_n02: 'm1' });
});

test('a correctly seated mining venture passes every invariant', () => {
  const s = stateWithVentures([
    { id: 'm1', ownerGuildId: 'g1', type: 'mining', siteId: 'pl_00001_n02', resourceType: 'titanium', productionRate: 5 },
  ]);
  assert.deepEqual(checkInvariants(s, 0), []);
});

test('a dangling siteId is caught', () => {
  const s = stateWithVentures([
    { id: 'm1', ownerGuildId: 'g1', type: 'mining', siteId: 'pl_99999_n99', resourceType: 'titanium', productionRate: 1 },
  ]);
  assert.equal(hasRule(s, 'site-exists'), true);
});

test('a resourceType that disagrees with the node is caught', () => {
  // pl_00001_n01 is lead, not titanium
  const s = stateWithVentures([
    { id: 'm1', ownerGuildId: 'g1', type: 'mining', siteId: 'pl_00001_n01', resourceType: 'titanium', productionRate: 1 },
  ]);
  assert.equal(hasRule(s, 'venture-resource-matches-node'), true);
});

test('a systemId stamped to match the site passes (ruling B1)', () => {
  const sysId = getSite('pl_00001_n02').systemId;
  const s = stateWithVentures([
    { id: 'm1', ownerGuildId: 'g1', type: 'mining', siteId: 'pl_00001_n02', systemId: sysId, resourceType: 'titanium', productionRate: 1 },
  ]);
  assert.deepEqual(checkInvariants(s, 0), []);
});

test('a systemId that disagrees with the site is caught (ruling B1)', () => {
  // pl_00001_n02 does not sit in sys_9999
  const s = stateWithVentures([
    { id: 'm1', ownerGuildId: 'g1', type: 'mining', siteId: 'pl_00001_n02', systemId: 'sys_9999', resourceType: 'titanium', productionRate: 1 },
  ]);
  assert.equal(hasRule(s, 'venture-system-matches-site'), true);
});

test('a mining venture parked on a settlement slot is caught', () => {
  const s = stateWithVentures([
    { id: 'm1', ownerGuildId: 'g1', type: 'mining', siteId: 'pl_00001_s01', resourceType: 'titanium', productionRate: 1 },
  ]);
  assert.equal(hasRule(s, 'mining-venture-on-resource-node'), true);
});

test('two ventures on the same site is caught', () => {
  const s = stateWithVentures([
    { id: 'm1', ownerGuildId: 'g1', type: 'mining', siteId: 'pl_00001_n02', resourceType: 'titanium', productionRate: 1 },
    { id: 'm2', ownerGuildId: 'g1', type: 'mining', siteId: 'pl_00001_n02', resourceType: 'titanium', productionRate: 1 },
  ]);
  assert.equal(hasRule(s, 'one-venture-per-site'), true);
});

test('an unseated mining venture (no siteId) is legal — production runs off resourceType', () => {
  const s = stateWithVentures([
    { id: 'm1', ownerGuildId: 'g1', type: 'mining', resourceType: 'titanium', productionRate: 5 },
  ]);
  assert.deepEqual(checkInvariants(s, 0), []);
});
