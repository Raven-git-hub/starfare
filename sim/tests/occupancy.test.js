'use strict';

// Tests sim/occupancy.js (the derived "what's on this site" map) and the
// site-occupancy invariant in invariants.js (referential integrity between a
// venture's siteId and the static seed). Keys off the Terran homeworld (via
// home-anchor.js) so the ids survive a seed regen: HOME_MINE (_n01) is titanium,
// ${HOME_PLANET}_n04 is lead (Terran's guaranteed spread, §2), HOME_SLOT (_s01) a
// settlement slot.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { computeOccupancy } = require('../occupancy.js');
const { checkInvariants } = require('../invariants.js');
const { getSite } = require('../seed.js');
const { HOME_PLANET, HOME_MINE, HOME_SLOT } = require('./home-anchor.js');

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
    { id: 'm1', ownerGuildId: 'g1', type: 'mining', siteId: HOME_MINE, resourceType: 'titanium', productionRate: 1 },
    { id: 'm2', ownerGuildId: 'g1', type: 'mining', resourceType: 'lead', productionRate: 1 }, // unseated
  ]);
  assert.deepEqual(computeOccupancy(s), { [HOME_MINE]: 'm1' });
});

test('a correctly seated mining venture passes every invariant', () => {
  const s = stateWithVentures([
    { id: 'm1', ownerGuildId: 'g1', type: 'mining', siteId: HOME_MINE, resourceType: 'titanium', productionRate: 5 },
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
  // ${HOME_PLANET}_n04 is lead (Terran's guaranteed spread), not titanium
  const s = stateWithVentures([
    { id: 'm1', ownerGuildId: 'g1', type: 'mining', siteId: `${HOME_PLANET}_n04`, resourceType: 'titanium', productionRate: 1 },
  ]);
  assert.equal(hasRule(s, 'venture-resource-matches-node'), true);
});

test('a systemId stamped to match the site passes (ruling B1)', () => {
  const sysId = getSite(HOME_MINE).systemId;
  const s = stateWithVentures([
    { id: 'm1', ownerGuildId: 'g1', type: 'mining', siteId: HOME_MINE, systemId: sysId, resourceType: 'titanium', productionRate: 1 },
  ]);
  assert.deepEqual(checkInvariants(s, 0), []);
});

test('a systemId that disagrees with the site is caught (ruling B1)', () => {
  // HOME_MINE does not sit in sys_9999
  const s = stateWithVentures([
    { id: 'm1', ownerGuildId: 'g1', type: 'mining', siteId: HOME_MINE, systemId: 'sys_9999', resourceType: 'titanium', productionRate: 1 },
  ]);
  assert.equal(hasRule(s, 'venture-system-matches-site'), true);
});

test('a mining venture parked on a settlement slot is caught', () => {
  const s = stateWithVentures([
    { id: 'm1', ownerGuildId: 'g1', type: 'mining', siteId: HOME_SLOT, resourceType: 'titanium', productionRate: 1 },
  ]);
  assert.equal(hasRule(s, 'mining-venture-on-resource-node'), true);
});

test('two ventures on the same site is caught', () => {
  const s = stateWithVentures([
    { id: 'm1', ownerGuildId: 'g1', type: 'mining', siteId: HOME_MINE, resourceType: 'titanium', productionRate: 1 },
    { id: 'm2', ownerGuildId: 'g1', type: 'mining', siteId: HOME_MINE, resourceType: 'titanium', productionRate: 1 },
  ]);
  assert.equal(hasRule(s, 'one-venture-per-site'), true);
});

test('an unseated mining venture (no siteId) is legal — production runs off resourceType', () => {
  const s = stateWithVentures([
    { id: 'm1', ownerGuildId: 'g1', type: 'mining', resourceType: 'titanium', productionRate: 5 },
  ]);
  assert.deepEqual(checkInvariants(s, 0), []);
});
