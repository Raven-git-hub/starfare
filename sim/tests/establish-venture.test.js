'use strict';

// Tests the establishVenture action (testbed slice 1, 03-08-26): seating a new
// mining venture on a real seed node so it produces on the next tick, with the
// occupancy rules enforced up front by validation (and backstopped every tick by
// the site-occupancy invariant).
//
// Real seed ids used: sys_0002 is the player's starter home; pl_00004_n01 and
// pl_00004_n02 are two titanium nodes on its Terran homeworld; pl_00004_s01 is a
// settlement slot (not a resource node); pl_00004 is a gold-and-more homeworld,
// so 'gold' is a real good but not pl_00004_n01's.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { advance } = require('../run.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { checkInvariants } = require('../invariants.js');
const { guildTotals } = require('../stock.js');
const {
  intake, validateAction, createFoundGuildAction, createEstablishVentureAction,
} = require('../actions.js');

// A galaxy with the player founded on sys_0002, no ventures yet.
function playerFounded() {
  const s = createZeroState();
  return advance(s, [createFoundGuildAction({ guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: 'sys_0002' })]).state;
}

// --- constructor guards ----------------------------------------------------

test('createEstablishVentureAction requires guild/venture/site/resource/rate', () => {
  assert.throws(() => createEstablishVentureAction({ ventureId: 'v', siteId: 's', resourceType: 't', productionRate: 5 }), /guildId is required/);
  assert.throws(() => createEstablishVentureAction({ guildId: 'g', siteId: 's', resourceType: 't', productionRate: 5 }), /ventureId is required/);
  assert.throws(() => createEstablishVentureAction({ guildId: 'g', ventureId: 'v', resourceType: 't', productionRate: 5 }), /siteId is required/);
  assert.throws(() => createEstablishVentureAction({ guildId: 'g', ventureId: 'v', siteId: 's', productionRate: 5 }), /resourceType is required/);
  assert.throws(() => createEstablishVentureAction({ guildId: 'g', ventureId: 'v', siteId: 's', resourceType: 't' }), /productionRate is required/);
});

// --- the happy path: establish, then production mints ----------------------

test('establishing a mine seats it and it produces on the next tick', () => {
  const s = playerFounded();
  const { state: next, results } = advance(s, [
    createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_1', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5 }),
  ]);
  assert.equal(results[0].accepted, true);
  const g = next.guilds[0];
  assert.equal(g.ventures.length, 1);
  assert.equal(g.ventures[0].siteId, 'pl_00004_n01');
  // establish + the same advance()'s tick => one batch already extracted.
  assert.equal(guildTotals(g).titanium, 5);
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('two mines on two nodes sum their rates each tick', () => {
  let s = playerFounded();
  s = advance(s, [createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_1', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5 })]).state; // +5 => 5
  s = advance(s, [createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_2', siteId: 'pl_00004_n02', resourceType: 'titanium', productionRate: 3 })]).state; // +5+3 => 13
  assert.equal(guildTotals(s.guilds[0]).titanium, 13);
  s = advance(s, []).state; // quiet tick: +8 => 21
  assert.equal(guildTotals(s.guilds[0]).titanium, 21);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- rejections ------------------------------------------------------------

test('establishing for a non-existent guild is rejected', () => {
  const v = validateAction(playerFounded(), createEstablishVentureAction({ guildId: 'ghost', ventureId: 'v', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5 }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /no guild/);
});

test('a duplicate venture id is rejected', () => {
  let s = playerFounded();
  s = advance(s, [createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_1', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5 })]).state;
  const v = validateAction(s, createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_1', siteId: 'pl_00004_n02', resourceType: 'titanium', productionRate: 5 }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /already exists/);
});

test('a site that does not exist in the seed is rejected', () => {
  const v = validateAction(playerFounded(), createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'v', siteId: 'pl_99999_n99', resourceType: 'titanium', productionRate: 5 }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /does not exist/);
});

test('a settlement slot is rejected (mining ventures need a resource node)', () => {
  const v = validateAction(playerFounded(), createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'v', siteId: 'pl_00004_s01', resourceType: 'titanium', productionRate: 5 }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /not a resource node/);
});

test('a resourceType that does not match the node is rejected', () => {
  const v = validateAction(playerFounded(), createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'v', siteId: 'pl_00004_n01', resourceType: 'gold', productionRate: 5 }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /does not match/);
});

test('an already-occupied node is rejected', () => {
  let s = playerFounded();
  s = advance(s, [createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_1', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5 })]).state;
  const v = validateAction(s, createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_2', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5 }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /already occupied/);
});

test('a non-positive or non-integer productionRate is rejected', () => {
  const s = playerFounded();
  for (const rate of [0, -3, 2.5]) {
    const v = validateAction(s, createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'v', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: rate }));
    assert.equal(v.valid, false, `rate ${rate} should be rejected`);
    assert.match(v.reason, /positive integer/);
  }
});

// --- racing: two ventures for the same node in one batch -------------------

test('two ventures racing for the same node: first-valid-wins', () => {
  const s = playerFounded();
  const { state: next, results } = intake(s, [
    createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'first', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5 }),
    createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'second', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5 }),
  ]);
  assert.equal(results[0].accepted, true);
  assert.equal(results[1].accepted, false);
  assert.match(results[1].reason, /already occupied/);
  assert.equal(next.guilds[0].ventures.length, 1);
});
