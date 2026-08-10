'use strict';

// Tests the System Production Profile accessor layer and its wiring into the tick:
//   - the sim/profile.js accessor layer (defaults, partial fills, round-trip);
//   - that the profile is now LIVE — slice 2a-i's no-op proof is INVERTED here:
//     stepProduction reads the profile (slice 2a-ii), so a profile now MOVES
//     production output. (The detailed per-gate behaviour lives in gates.test.js.)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createGuild } = require('../state.js');
const { getGoodPolicy, getThrottlePct, setEntry } = require('../profile.js');
const { advance } = require('../run.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const {
  createFoundGuildAction,
  createEstablishVentureAction,
  createSetProductionProfileAction,
} = require('../actions.js');
const { canonicalStringify, hashState } = require('../serialize.js');

const DEFAULT_POLICY = {
  order: ['syndicate', 'downstream', 'stockpile'],
  downstreamPct: 100,
  stockpile: { mode: 'percent', value: 0 },
  reserveFloor: 0,
};

// --- accessor defaults -----------------------------------------------------

test('a guild with no profile returns the all-defaults policy and throttle 100', () => {
  const g = createGuild({ id: 'g1', credits: 0, fuelHoard: 0 });
  assert.deepEqual(getGoodPolicy(g, 'sys_0002', 'titanium'), DEFAULT_POLICY);
  assert.equal(getThrottlePct(g, 'sys_0002', 'anyVenture'), 100);
});

test('a partially-set good entry fills only the set fields and defaults the rest', () => {
  const g = createGuild({ id: 'g1', credits: 0, fuelHoard: 0 });
  setEntry(g, 'sys_0002', { goods: { titanium: { downstreamPct: 40 } } });
  assert.deepEqual(getGoodPolicy(g, 'sys_0002', 'titanium'), {
    order: ['syndicate', 'downstream', 'stockpile'], // defaulted
    downstreamPct: 40,                               // set
    stockpile: { mode: 'percent', value: 0 },        // defaulted
    reserveFloor: 0,                                 // defaulted
  });
  // A DIFFERENT good in the same system still defaults everything.
  assert.deepEqual(getGoodPolicy(g, 'sys_0002', 'copper'), DEFAULT_POLICY);
});

test('a set policy and throttle round-trip back through get', () => {
  const g = createGuild({ id: 'g1', credits: 0, fuelHoard: 0 });
  setEntry(g, 'sys_0002', {
    goods: {
      copper: {
        order: ['stockpile', 'syndicate', 'downstream'],
        downstreamPct: 0,
        stockpile: { mode: 'quantity', value: 500 },
      },
    },
    throttles: { refinery: 25 },
  });
  assert.deepEqual(getGoodPolicy(g, 'sys_0002', 'copper'), {
    order: ['stockpile', 'syndicate', 'downstream'],
    downstreamPct: 0,
    stockpile: { mode: 'quantity', value: 500 },
    reserveFloor: 0,
  });
  assert.equal(getThrottlePct(g, 'sys_0002', 'refinery'), 25);
});

test('a second setEntry merges field-by-field, not wholesale replace', () => {
  const g = createGuild({ id: 'g1', credits: 0, fuelHoard: 0 });
  setEntry(g, 'sys_0002', { goods: { titanium: { order: ['downstream', 'stockpile', 'syndicate'] } } });
  setEntry(g, 'sys_0002', { goods: { titanium: { downstreamPct: 60 } } });
  assert.deepEqual(getGoodPolicy(g, 'sys_0002', 'titanium'), {
    order: ['downstream', 'stockpile', 'syndicate'], // survived the second patch
    downstreamPct: 60,                               // added by the second patch
    stockpile: { mode: 'percent', value: 0 },
    reserveFloor: 0,
  });
});

test('getGoodPolicy returns a fresh object — a caller cannot alias into state', () => {
  const g = createGuild({ id: 'g1', credits: 0, fuelHoard: 0 });
  setEntry(g, 'sys_0002', { goods: { titanium: { downstreamPct: 40 } } });
  const p = getGoodPolicy(g, 'sys_0002', 'titanium');
  p.order.push('junk');
  p.downstreamPct = 999;
  p.stockpile.value = 999;
  // Re-read: engine state is untouched by the caller's mutation.
  assert.deepEqual(getGoodPolicy(g, 'sys_0002', 'titanium'), {
    order: ['syndicate', 'downstream', 'stockpile'],
    downstreamPct: 40,
    stockpile: { mode: 'percent', value: 0 },
    reserveFloor: 0,
  });
});

// --- the no-op proof (load-bearing) ---------------------------------------

// A mine (+carbon mine) feeding a refinery on sys_0002, run 50 ticks. Both runs
// tick the SAME number of times; they differ only in whether the profile window
// carries a setProductionProfile action or an empty batch — so any difference in
// output could ONLY come from the tick reading the profile, which it must not.
function runScenario(profileActions) {
  let s = createZeroState();
  s = advance(s, [createFoundGuildAction({ guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: 'sys_0002' })]).state;
  s = advance(s, [createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'tmine', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5 })]).state;
  s = advance(s, [createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'cmine', siteId: 'pl_00004_n08', resourceType: 'carbon_products', productionRate: 5 })]).state;
  s = advance(s, [createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'refinery', type: 'refining', siteId: 'pl_00004_s01', recipeId: 'titanium_alloy', productionRate: 2 })]).state;
  // The profile window: an empty batch in the control run, the setProductionProfile
  // action in the treatment run. One tick either way.
  s = advance(s, profileActions).state;
  for (let i = 0; i < 50; i += 1) s = advance(s, []).state;
  return s;
}

// An aggressive, fully-populated profile — a reordered waterfall with a 90%
// stockpile floor on titanium and the refinery throttled hard — so the tick that
// now reads it MUST move the supply. (Includes a throttle naming a NON-EXISTENT
// venture, harmlessly ignored — see the reconciliation tests in gates.test.js.)
const profileAction = createSetProductionProfileAction({
  guildId: 'player-guild',
  systemId: 'sys_0002',
  goods: {
    titanium: { order: ['stockpile', 'downstream', 'syndicate'], downstreamPct: 10, stockpile: { mode: 'percent', value: 90 } },
  },
  throttles: { refinery: 1, 'ghost-venture': 50 },
});

// The slice-2a-i no-op proof, INVERTED: the profile is no longer inert. With a
// 90%-of-fresh titanium stockpile floor ranked first and the refinery throttled to
// 1%, the treatment run must produce STRICTLY LESS titanium_alloy than the control.
test('a profile now MOVES production output — the tick reads it (2a-i no-op proof inverted)', () => {
  const control = runScenario([]);
  const treatment = runScenario([profileAction]);
  assert.notEqual(
    canonicalStringify(control.galacticSupply),
    canonicalStringify(treatment.galacticSupply),
    'the tick now reads the profile, so a profile must move production output',
  );
  assert.ok(
    (treatment.galacticSupply.resources.titanium_alloy || 0) < control.galacticSupply.resources.titanium_alloy,
    'throttling the refinery + hoarding its titanium starves alloy production',
  );
  // And the profile really WAS stored.
  assert.equal(getThrottlePct(treatment.guilds[0], 'sys_0002', 'refinery'), 1);
});

test('determinism holds with the profile field present — run twice, hashes equal', () => {
  assert.equal(hashState(runScenario([profileAction])), hashState(runScenario([profileAction])));
});
