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
const { guildTotals, getStock } = require('../stock.js');
const { getSite } = require('../seed.js');
const {
  validateAction, createFoundGuildAction, createEstablishVentureAction,
} = require('../actions.js');

function playerFounded() {
  const s = createZeroState();
  return advance(s, [createFoundGuildAction({ guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: 'sys_0002' })]).state;
}
const tmine = (over = {}) => createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'tmine', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5, ...over });
const cmine = (over = {}) => createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'cmine', siteId: 'pl_00004_n08', resourceType: 'carbon_products', productionRate: 5, ...over });
const refinery = (over = {}) => createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'refinery', type: 'refining', siteId: 'pl_00004_s01', recipeId: 'titanium_alloy', productionRate: 2, ...over });

// --- constructor guards ----------------------------------------------------

test('a refining action requires a recipeId (not a resourceType)', () => {
  assert.throws(
    () => createEstablishVentureAction({ guildId: 'g', ventureId: 'v', type: 'refining', siteId: 'pl_00004_s01', productionRate: 1 }),
    /recipeId is required for a refining venture/,
  );
});

// --- establishing + converting (multi-input) -------------------------------

// NUMBERS UPDATED for slice 2a-ii's "never touch the pile" rule (§5): a refinery
// now draws only THIS tick's FRESH production, not the accumulated pile. Recipe
// titanium_alloy = 3 titanium + 1 carbon -> 1 alloy; refinery rate 2 => full-tilt
// demand 6 titanium/tick. But tmine mints only 5 fresh titanium/tick, so the
// downstream draw is capped at 5, affording floor(5/3) = 1 batch — NOT the 2 the
// old whole-pool draw managed by dipping into accumulated titanium. The pile grows
// and is left untouched; the alloy figure legitimately drops from 2/tick to 1/tick.
test('a refinery consumes BOTH inputs and produces titanium_alloy (fresh-only, never touches the pile)', () => {
  let s = playerFounded();
  s = advance(s, [tmine()]).state;      // +5 titanium => 5
  s = advance(s, [cmine()]).state;      // tmine +5 => 10 ti, cmine +5 => 5 carbon
  const r = advance(s, [refinery()]);   // mines first (=>15 ti, 10 carbon); fresh this tick = 5 ti / 5 carbon
  s = r.state;
  assert.equal(r.results[0].accepted, true);
  const g = () => guildTotals(s.guilds[0]);
  // Fresh titanium 5 (< demand 6) caps the draw at 5 => floor(5/3)=1 batch: -3 ti, -1 carbon, +1 alloy.
  assert.equal(g().titanium, 12);       // 15 - 3 (was 9 under whole-pool: -6)
  assert.equal(g().carbon_products, 9); // 10 - 1 (was 8: -2)
  assert.equal(g().titanium_alloy, 1);  // 1 batch, capped by fresh titanium (was 2)
  assert.deepEqual(checkInvariants(s, s.tick), []);
  s = advance(s, []).state;             // +5 ti/+5 carbon fresh; again 1 batch: -3 ti, -1 carbon, +1 alloy
  assert.equal(g().titanium, 14);       // 12 + 5 - 3 (was 8)
  assert.equal(g().carbon_products, 13);// 9 + 5 - 1 (was 11)
  assert.equal(g().titanium_alloy, 2);  // +1 (was 4)
  assert.equal(computeGalacticSupply(s).resources.titanium_alloy, 2);
});

// UPDATED for never-touch-the-pile: carbon fresh is 1/tick (the bottleneck), so the
// draw is capped at 1 fresh carbon => 1 batch, regardless of a pile of carbon or
// titanium built earlier. The accumulated carbon is NOT drained to zero any more —
// only the fresh unit is spent — but the invariant (never negative) still holds.
test('a refinery is capped by the SCARCEST FRESH input and never goes negative', () => {
  let s = playerFounded();
  s = advance(s, [tmine()]).state;                       // titanium accrues fast (5/tick) => 5
  s = advance(s, [cmine({ productionRate: 1 })]).state;  // tmine +5 => 10 ti; cmine +1 => 1 carbon (the bottleneck)
  // rate 100 wants 100 batches; fresh titanium 5 affords floor(5/3)=1, fresh carbon 1 affords floor(1/1)=1.
  s = advance(s, [refinery({ productionRate: 100 })]).state; // mines +5 ti (=>15) / +1 carbon (=>2) fresh 5/1
  const g = guildTotals(s.guilds[0]);
  assert.equal(g.carbon_products, 1);   // pool 2 (1 old + 1 fresh) - 1 consumed = 1 (was 0: old drew the pile too)
  assert.equal(g.titanium_alloy, 1);    // 1 batch, capped by fresh carbon (was 2)
  assert.equal(g.titanium, 12);         // 15 - 1*3 (was 9)
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('a refinery missing ANY input produces nothing (no-op, stays green)', () => {
  let s = playerFounded();
  // titanium mine but NO carbon mine: one input is present, the other is absent.
  s = advance(s, [tmine()]).state;                 // titanium => 5
  s = advance(s, [refinery()]).state;              // mine +5 => 10 ti; carbon 0 => 0 batches
  const g = guildTotals(s.guilds[0]);
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

// Ruling B1 (§15.2): production must pool in the venture's OWN system. A mine
// founded via foundGuild's INLINE ventures (the demo.js / snapshot-CLI path) used
// to skip systemId stamping — establishVenture stamped it, foundGuild did not —
// so its output pooled under a stray `null` system key. The flat guild total hid
// it (guildTotals sums across pools), but a same-system refinery drawing from the
// real system pool would starve. This pins the fix: inline-founded output lands
// in the site's system pool, and no null-keyed pool is created.
test('a mine founded via foundGuild inline ventures pools output in the site\'s system, not a null pool (ruling B1)', () => {
  const found = createFoundGuildAction({
    guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: 'sys_0002',
    ventures: [
      { id: 'mine_1', ownerGuildId: 'player-guild', type: 'mining', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5 },
    ],
  });
  const s = advance(createZeroState(), [found]).state; // founding also runs one tick => +5 titanium
  const g = s.guilds[0];
  const sysId = getSite('pl_00004_n01').systemId; // sys_0002
  assert.equal(g.ventures[0].systemId, sysId, 'the inline venture must be stamped with its site\'s systemId');
  assert.equal(getStock(g, sysId, 'titanium'), 5, 'output pools in the site\'s system');
  assert.equal(getStock(g, null, 'titanium'), 0, 'nothing pools under a null system');
  assert.ok(!Object.prototype.hasOwnProperty.call(g.stockpiles, 'null'), 'no stray "null" pool exists');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// The consequence the null-pool bug caused: a same-system refinery starved
// because its input sat in the wrong pool. Founded inline (titanium mine) then a
// refinery deployed in the same system must actually convert.
test('an inline-founded mine feeds a same-system refinery (the starvation the null-pool bug caused)', () => {
  const found = createFoundGuildAction({
    guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: 'sys_0002',
    ventures: [
      { id: 'tmine', ownerGuildId: 'player-guild', type: 'mining', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5 },
      { id: 'cmine', ownerGuildId: 'player-guild', type: 'mining', siteId: 'pl_00004_n08', resourceType: 'carbon_products', productionRate: 5 },
    ],
  });
  let s = advance(createZeroState(), [found]).state; // +5 ti, +5 carbon
  s = advance(s, [refinery()]).state;                // deploy + tick: 3 ti + 1 carbon -> 1 alloy (rate 2, but only ~1 batch of inputs early)
  s = advance(s, []).state;                          // another tick keeps converting
  const totals = guildTotals(s.guilds[0]);
  assert.ok((totals.titanium_alloy || 0) > 0, 'the refinery converts — its input pooled in the same system');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});
