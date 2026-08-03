'use strict';

// Tests refining ventures (03-08-26): a venture on a SETTLEMENT SLOT that runs a
// recipes.js recipe — consuming a raw good, producing a processed good — the
// first raw->processed conversion. Uses real seed ids: pl_00004_n01/_n02 are
// titanium nodes on sys_0002's homeworld; pl_00004_s01/_s02 are settlement slots.
// Recipe titanium_to_alloy = 3 titanium -> 1 alloy_ingot per batch.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { advance } = require('../run.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { checkInvariants } = require('../invariants.js');
const { computeGalacticSupply } = require('../supply.js');
const {
  validateAction, createFoundGuildAction, createEstablishVentureAction,
} = require('../actions.js');

function playerFounded() {
  const s = createZeroState();
  return advance(s, [createFoundGuildAction({ guildId: 'player', credits: 120, influence: 100, homeSystemId: 'sys_0002' })]).state;
}
const mine = (over = {}) => createEstablishVentureAction({ guildId: 'player', ventureId: 'mine', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5, ...over });
const refinery = (over = {}) => createEstablishVentureAction({ guildId: 'player', ventureId: 'refinery', type: 'refining', siteId: 'pl_00004_s01', recipeId: 'titanium_to_alloy', productionRate: 2, ...over });

// --- constructor guards ----------------------------------------------------

test('a refining action requires a recipeId (not a resourceType)', () => {
  assert.throws(
    () => createEstablishVentureAction({ guildId: 'g', ventureId: 'v', type: 'refining', siteId: 'pl_00004_s01', productionRate: 1 }),
    /recipeId is required for a refining venture/,
  );
});

// --- establishing + converting ---------------------------------------------

test('a refinery on a settlement slot converts titanium to alloy ingots', () => {
  let s = playerFounded();
  s = advance(s, [mine()]).state;       // +5 titanium/tick
  const r = advance(s, [refinery()]);   // rate 2 batches = 6 titanium -> 2 alloy
  s = r.state;
  assert.equal(r.results[0].accepted, true);
  const g = () => s.guilds[0].stockpiles;
  // this tick: mine +5 (=>10), refinery consumes 6 => 4 titanium, produces 2 alloy
  assert.equal(g().titanium, 4);
  assert.equal(g().alloy_ingots, 2);
  assert.deepEqual(checkInvariants(s, s.tick), []);
  s = advance(s, []).state; // +5 => 9, -6 => 3 titanium, +2 => 4 alloy
  assert.equal(g().titanium, 3);
  assert.equal(g().alloy_ingots, 4);
  // the processed good shows up in the galactic totals
  assert.equal(computeGalacticSupply(s).resources.alloy_ingots, 4);
});

test('a refinery throttles to available input and never goes negative', () => {
  let s = playerFounded();
  s = advance(s, [mine()]).state;                                  // +5 titanium => 5
  // rate 100 batches wants 300 titanium; only ~10 exist after the mine ticks.
  s = advance(s, [refinery({ productionRate: 100 })]).state;       // mine +5 => 10; floor(10/3)=3 batches
  const g = s.guilds[0].stockpiles;
  assert.equal(g.titanium, 1);        // 10 - 3*3 = 1  (never negative)
  assert.equal(g.alloy_ingots, 3);    // 3*1
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('a refinery with no input produces nothing (no-op, stays green)', () => {
  let s = playerFounded();
  // refinery but NO mine: the guild holds no titanium.
  s = advance(s, [refinery()]).state;
  const g = s.guilds[0].stockpiles || {};
  assert.equal(g.titanium || 0, 0);
  assert.equal(g.alloy_ingots || 0, 0);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- rejections ------------------------------------------------------------

test('a refinery on a resource node is rejected', () => {
  const v = validateAction(playerFounded(), refinery({ siteId: 'pl_00004_n02' }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /not a settlement slot/);
});

test('a mining venture on a settlement slot is rejected', () => {
  const v = validateAction(playerFounded(), mine({ siteId: 'pl_00004_s01' }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /not a resource node/);
});

test('an unknown recipeId is rejected', () => {
  const v = validateAction(playerFounded(), refinery({ recipeId: 'lead_to_gold' }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /not a known recipe/);
});

test('two ventures cannot share a settlement slot', () => {
  let s = playerFounded();
  s = advance(s, [refinery()]).state;
  const v = validateAction(s, refinery({ ventureId: 'refinery2' }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /already occupied/);
});
