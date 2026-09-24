'use strict';

// Tests the establishVenture action (testbed slice 1, 03-08-26): seating a new
// mining venture on a real seed node so it produces on the next tick, with the
// occupancy rules enforced up front by validation (and backstopped every tick by
// the site-occupancy invariant).
//
// The home is DERIVED from the seed (home-anchor.js): HOME_SYSTEM is the first
// starter, HOME_PLANET its Terran homeworld. HOME_MINE / HOME_MINE_2 are its first
// two nodes -- always titanium (§2's guaranteed spread) -- and HOME_SLOT a
// settlement slot (not a resource node). A Terran homeworld always carries gold
// too, so 'gold' is a real good but not HOME_MINE's.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { advance } = require('../run.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { checkInvariants } = require('../invariants.js');
const { guildTotals } = require('../stock.js');
const {
  intake, validateAction, createFoundGuildAction, createEstablishVentureAction,
} = require('../actions.js');
const { HOME_SYSTEM, HOME_PLANET, HOME_MINE, HOME_MINE_2, HOME_SLOT } = require('./home-anchor.js');
const { MINE_BASELINE, REFINERY_BASELINE, baselineRateFor } = require('../baseline.js');

// Two of the fifteen Miners founding gifts the player (sim/assets.js's id scheme).
// A deploy NAMES the machine it occupies (design.md §4, 31-08-26), so every establish
// below says which one — and these two are the ones the old auto-pick would have
// taken, so the production numbers pinned here are the same ones as before.
const M1 = 'asset_player-guild_miner_01';
const M2 = 'asset_player-guild_miner_02';

// A galaxy with the player founded on the home system, no ventures yet.
function playerFounded() {
  const s = createZeroState();
  return advance(s, [createFoundGuildAction({ guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: HOME_SYSTEM })]).state;
}

// --- constructor guards ----------------------------------------------------

test('createEstablishVentureAction requires guild/venture/site/asset/resource', () => {
  assert.throws(() => createEstablishVentureAction({ ventureId: 'v', siteId: 's', assetId: 'a', resourceType: 't', productionRate: 5 }), /guildId is required/);
  assert.throws(() => createEstablishVentureAction({ guildId: 'g', siteId: 's', assetId: 'a', resourceType: 't', productionRate: 5 }), /ventureId is required/);
  assert.throws(() => createEstablishVentureAction({ guildId: 'g', ventureId: 'v', assetId: 'a', resourceType: 't', productionRate: 5 }), /siteId is required/);
  assert.throws(() => createEstablishVentureAction({ guildId: 'g', ventureId: 'v', siteId: 's', resourceType: 't', productionRate: 5 }), /assetId is required/);
  assert.throws(() => createEstablishVentureAction({ guildId: 'g', ventureId: 'v', siteId: 's', assetId: 'a', productionRate: 5 }), /resourceType is required/);
  // The rate is NOT required any more (design.md §2, 24-09-26): omitted, the engine
  // stamps the venture's baseline. The rate tests are in their own section below.
  assert.doesNotThrow(() => createEstablishVentureAction({ guildId: 'g', ventureId: 'v', siteId: 's', assetId: 'a', resourceType: 't' }));
});

test('the action carries the caller\'s assetId through unchanged', () => {
  const a = createEstablishVentureAction({ guildId: 'g', ventureId: 'v', siteId: 's', assetId: 'a_7', resourceType: 't', productionRate: 5 });
  assert.equal(a.assetId, 'a_7', 'which machine to deploy is the caller\'s choice, carried verbatim');
});

// --- the happy path: establish, then production mints ----------------------

test('establishing a mine seats it and it produces on the next tick', () => {
  const s = playerFounded();
  const { state: next, results } = advance(s, [
    createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_1', siteId: HOME_MINE, assetId: M1, resourceType: 'titanium', productionRate: 5 }),
  ]);
  assert.equal(results[0].accepted, true);
  const g = next.guilds[0];
  assert.equal(g.ventures.length, 1);
  assert.equal(g.ventures[0].siteId, HOME_MINE);
  // establish + the same advance()'s tick => one batch already extracted.
  assert.equal(guildTotals(g).titanium, 5);
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('two mines on two nodes sum their rates each tick', () => {
  let s = playerFounded();
  s = advance(s, [createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_1', siteId: HOME_MINE, assetId: M1, resourceType: 'titanium', productionRate: 5 })]).state; // +5 => 5
  s = advance(s, [createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_2', siteId: HOME_MINE_2, assetId: M2, resourceType: 'titanium', productionRate: 3 })]).state; // +5+3 => 13
  assert.equal(guildTotals(s.guilds[0]).titanium, 13);
  s = advance(s, []).state; // quiet tick: +8 => 21
  assert.equal(guildTotals(s.guilds[0]).titanium, 21);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- rejections ------------------------------------------------------------

test('establishing for a non-existent guild is rejected', () => {
  const v = validateAction(playerFounded(), createEstablishVentureAction({ guildId: 'ghost', ventureId: 'v', siteId: HOME_MINE, assetId: M1, resourceType: 'titanium', productionRate: 5 }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /no guild/);
});

test('a duplicate venture id is rejected', () => {
  let s = playerFounded();
  s = advance(s, [createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_1', siteId: HOME_MINE, assetId: M1, resourceType: 'titanium', productionRate: 5 })]).state;
  const v = validateAction(s, createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_1', siteId: HOME_MINE_2, assetId: M2, resourceType: 'titanium', productionRate: 5 }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /already exists/);
});

test('a site that does not exist in the seed is rejected', () => {
  const v = validateAction(playerFounded(), createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'v', siteId: 'pl_99999_n99', assetId: M1, resourceType: 'titanium', productionRate: 5 }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /does not exist/);
});

test('a settlement slot is rejected (mining ventures need a resource node)', () => {
  const v = validateAction(playerFounded(), createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'v', siteId: HOME_SLOT, assetId: M1, resourceType: 'titanium', productionRate: 5 }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /not a resource node/);
});

test('a resourceType that does not match the node is rejected', () => {
  const v = validateAction(playerFounded(), createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'v', siteId: HOME_MINE, assetId: M1, resourceType: 'gold', productionRate: 5 }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /does not match/);
});

test('an already-occupied node is rejected', () => {
  let s = playerFounded();
  s = advance(s, [createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_1', siteId: HOME_MINE, assetId: M1, resourceType: 'titanium', productionRate: 5 })]).state;
  // A free machine, so the ONLY thing wrong with this deploy is the site.
  const v = validateAction(s, createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_2', siteId: HOME_MINE, assetId: M2, resourceType: 'titanium', productionRate: 5 }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /already occupied/);
});

test('a non-positive or non-integer productionRate is rejected', () => {
  const s = playerFounded();
  // `null` is a rate the caller NAMED (a JSON body can send it), so it is judged like
  // any other bad rate — only an ABSENT rate is the engine's to stamp.
  for (const rate of [0, -3, 2.5, null, '5']) {
    const v = validateAction(s, createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'v', siteId: HOME_MINE, assetId: M1, resourceType: 'titanium', productionRate: rate }));
    assert.equal(v.valid, false, `rate ${rate} should be rejected`);
    assert.match(v.reason, /positive integer/);
  }
});

// --- racing: two ventures for the same node in one batch -------------------

test('two ventures racing for the same node: first-valid-wins', () => {
  const s = playerFounded();
  const { state: next, results } = intake(s, [
    createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'first', siteId: HOME_MINE, assetId: M1, resourceType: 'titanium', productionRate: 5 }),
    // A DIFFERENT machine, so the only thing these two contend for is the node —
    // the asset race is its own test (assets.test.js).
    createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'second', siteId: HOME_MINE, assetId: M2, resourceType: 'titanium', productionRate: 5 }),
  ]);
  assert.equal(results[0].accepted, true);
  assert.equal(results[1].accepted, false);
  assert.match(results[1].reason, /already occupied/);
  assert.equal(next.guilds[0].ventures.length, 1);
});

// --- the engine-stamped rate (design.md §2 "A mine's yield IS its establish rate") --
//
// An establish that names no rate gets the venture's droidless BASELINE as its
// `productionRate` — the same figure its licence is priced off, so a licence can never
// commit a share of output the venture does not make. The expectations below read the
// tables live (MINE_BASELINE / REFINERY_BASELINE), so they hold at any tuning.

const F1 = 'asset_player-guild_factory_01';

test('the action omits productionRate when none is given, and is unchanged when one is', () => {
  const bare = createEstablishVentureAction({ guildId: 'g', ventureId: 'v', siteId: 's', assetId: 'a', resourceType: 't' });
  assert.equal(Object.prototype.hasOwnProperty.call(bare, 'productionRate'), false,
    'no key at all, so the engine (not a stray undefined) decides the rate');
  // A caller that names its rate gets the same keys, in the same order, as before the
  // rate became optional: every existing caller's action is byte-identical.
  const named = createEstablishVentureAction({ guildId: 'g', ventureId: 'v', siteId: 's', assetId: 'a', resourceType: 't', productionRate: 5 });
  assert.deepEqual(Object.keys(named),
    ['type', 'guildId', 'ventureId', 'ventureType', 'siteId', 'assetId', 'resourceType', 'recipeId', 'productionRate']);
  assert.equal(named.productionRate, 5);
});

test('a mine established with no rate runs at its MINE_BASELINE, from the first tick', () => {
  const s = playerFounded();
  const { state: next, results } = advance(s, [
    createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_1', siteId: HOME_MINE, assetId: M1, resourceType: 'titanium' }),
  ]);
  assert.equal(results[0].accepted, true, results[0].reason);
  const v = next.guilds[0].ventures[0];
  assert.equal(v.productionRate, MINE_BASELINE.titanium, 'the engine stamped the titanium baseline');
  // It really runs at that rate: establish + the same advance()'s tick mines one tick's worth.
  assert.equal(guildTotals(next.guilds[0]).titanium, MINE_BASELINE.titanium);
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('a factory established with no rate runs at its REFINERY_BASELINE, in batches/tick', () => {
  // A factory's rate is BATCHES/tick, so it is stamped from REFINERY_BASELINE[recipeId],
  // never from baselineOutputFor (output UNITS = batches x the recipe's output qty). Every
  // recipe makes 1 unit per batch today, so the two agree numerically; this pins the
  // right table, so a recipe that later makes 2 per batch cannot double its rate.
  const s = playerFounded();
  const { state: next, results } = advance(s, [
    createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'ref_1', type: 'refining', siteId: HOME_SLOT, assetId: F1, recipeId: 'titanium_alloy' }),
  ]);
  assert.equal(results[0].accepted, true, results[0].reason);
  const v = next.guilds[0].ventures[0];
  assert.equal(v.productionRate, REFINERY_BASELINE.titanium_alloy);
  assert.equal(v.productionRate, baselineRateFor({ recipeId: 'titanium_alloy' }), 'the one helper the engine stamps from');
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('a NAMED rate is honoured as given, even when it differs from the baseline', () => {
  // The operator and test scenarios can still set any positive rate. Capping it at the
  // baseline is the deferred throttle-below / droids-above refactor, not this slice.
  const named = MINE_BASELINE.titanium + 1;
  const s = playerFounded();
  const { state: next, results } = advance(s, [
    createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_1', siteId: HOME_MINE, assetId: M1, resourceType: 'titanium', productionRate: named }),
  ]);
  assert.equal(results[0].accepted, true, results[0].reason);
  assert.equal(next.guilds[0].ventures[0].productionRate, named);
  assert.equal(guildTotals(next.guilds[0]).titanium, named);
});

test('an establish with no rate still gets the ordinary refusals first', () => {
  // The stamp is looked up only once the resource or recipe is proven real, so a bad
  // request still learns what is actually wrong with it (not "no baseline").
  const s = playerFounded();
  const wrongGood = validateAction(s, createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'v', siteId: HOME_MINE, assetId: M1, resourceType: 'gold' }));
  assert.equal(wrongGood.valid, false);
  assert.match(wrongGood.reason, /does not match/);
  const noRecipe = validateAction(s, createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'v', type: 'refining', siteId: HOME_SLOT, assetId: F1, recipeId: 'no_such_recipe' }));
  assert.equal(noRecipe.valid, false);
  assert.match(noRecipe.reason, /not a known recipe/);
});
