'use strict';

// Tests refining ventures: a venture on a SETTLEMENT SLOT that runs a recipes.js
// recipe, consuming raw goods and producing a processed good — the first
// raw->processed conversion. Multi-input as of 04-08-26. Uses real seed ids:
// pl_00004_n01 is a titanium node and pl_00004_n08 a carbon_products node on
// sys_0002's homeworld; pl_00004_s01/_s02 are settlement slots.
// Recipe titanium_alloy = 3 titanium + 1 carbon_products -> 1 titanium_alloy
// per batch ([PLACEHOLDER] ratios).

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
const tmine = (over = {}) => createEstablishVentureAction({ guildId: 'player', ventureId: 'tmine', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5, ...over });
const cmine = (over = {}) => createEstablishVentureAction({ guildId: 'player', ventureId: 'cmine', siteId: 'pl_00004_n08', resourceType: 'carbon_products', productionRate: 5, ...over });
const refinery = (over = {}) => createEstablishVentureAction({ guildId: 'player', ventureId: 'refinery', type: 'refining', siteId: 'pl_00004_s01', recipeId: 'titanium_alloy', productionRate: 2, ...over });

// --- constructor guards ----------------------------------------------------

test('a refining action requires a recipeId (not a resourceType)', () => {
  assert.throws(
    () => createEstablishVentureAction({ guildId: 'g', ventureId: 'v', type: 'refining', siteId: 'pl_00004_s01', productionRate: 1 }),
    /recipeId is required for a refining venture/,
  );
});

// --- establishing + converting (multi-input) -------------------------------

test('a refinery consumes BOTH inputs and produces titanium_alloy', () => {
  let s = playerFounded();
  s = advance(s, [tmine()]).state;      // +5 titanium => 5
  s = advance(s, [cmine()]).state;      // +5 titanium => 10, +5 carbon => 5
  const r = advance(s, [refinery()]);   // mines first (=>15 ti, 10 carbon); rate 2 = 6 ti + 2 carbon -> 2 alloy
  s = r.state;
  assert.equal(r.results[0].accepted, true);
  const g = () => s.guilds[0].stockpiles;
  assert.equal(g().titanium, 9);        // 15 - 6
  assert.equal(g().carbon_products, 8); // 10 - 2
  assert.equal(g().titanium_alloy, 2);  // 2 batches * 1
  assert.deepEqual(checkInvariants(s, s.tick), []);
  s = advance(s, []).state;             // +5/+5 mines, -6 ti / -2 carbon, +2 alloy
  assert.equal(g().titanium, 8);
  assert.equal(g().carbon_products, 11);
  assert.equal(g().titanium_alloy, 4);
  assert.equal(computeGalacticSupply(s).resources.titanium_alloy, 4);
});

test('a refinery throttles to the SCARCEST input and never goes negative', () => {
  let s = playerFounded();
  s = advance(s, [tmine()]).state;                       // titanium accrues fast (5/tick)
  s = advance(s, [cmine({ productionRate: 1 })]).state;  // carbon accrues slowly (1/tick) => the bottleneck
  // rate 100 wants 100 batches; titanium could afford floor(15/3)=5, but carbon only floor(2/1)=2.
  s = advance(s, [refinery({ productionRate: 100 })]).state;
  const g = s.guilds[0].stockpiles;
  assert.equal(g.carbon_products, 0);   // carbon (scarcest) capped batches at 2, drained to exactly 0
  assert.equal(g.titanium_alloy, 2);    // 2 batches, not 5 (titanium) and not 100 (rate)
  assert.equal(g.titanium, 9);          // 15 - 2*3, plenty left over
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('a refinery missing ANY input produces nothing (no-op, stays green)', () => {
  let s = playerFounded();
  // titanium mine but NO carbon mine: one input is present, the other is absent.
  s = advance(s, [tmine()]).state;                 // titanium => 5
  s = advance(s, [refinery()]).state;              // mine +5 => 10 ti; carbon 0 => 0 batches
  const g = s.guilds[0].stockpiles;
  assert.equal(g.titanium, 10);                    // untouched — no batch ran
  assert.equal(g.titanium_alloy || 0, 0);
  assert.equal(g.carbon_products || 0, 0);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- rejections ------------------------------------------------------------

test('a refinery on a resource node is rejected', () => {
  const v = validateAction(playerFounded(), refinery({ siteId: 'pl_00004_n02' }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /not a settlement slot/);
});

test('a mining venture on a settlement slot is rejected', () => {
  const v = validateAction(playerFounded(), tmine({ siteId: 'pl_00004_s01' }));
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
