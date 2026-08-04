'use strict';

// Tests the derived galactic-supply totals (sim/supply.js) and the consistency
// invariant that keeps the on-state cache honest (sim/invariants.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { computeGalacticSupply } = require('../supply.js');
const { STOCKPILE_GOODS } = require('../resources.js');
const { tick } = require('../tick.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');

function twoGuildState() {
  return createState({
    guilds: [
      { id: 'g1', credits: 0, fuelHoard: 4, stockpiles: { sysA: { titanium: 10, copper: 3 } } },
      { id: 'g2', credits: 0, fuelHoard: 1, stockpiles: { sysB: { titanium: 5 } } },
    ],
    reserve: { reserveLevel: 30 },
    syndicate: { ledger: 0 },
  });
}

test('computeGalacticSupply sums stockpiles across guilds and zero-fills the rest', () => {
  const gs = computeGalacticSupply(twoGuildState());
  assert.equal(gs.resources.titanium, 15); // 10 + 5
  assert.equal(gs.resources.copper, 3);
  assert.equal(gs.resources.gold, 0, 'a good no one holds still has a (zero) row');
  assert.equal(gs.resources.titanium_alloy, 0, 'processed goods get a (zero) row too');
  assert.equal(Object.keys(gs.resources).length, STOCKPILE_GOODS.length, 'every stockpile good present (raw + processed)');
});

test('fuel is reported as communal reserve + guild-held, separately', () => {
  const gs = computeGalacticSupply(twoGuildState());
  assert.equal(gs.fuel.reserve, 30);
  assert.equal(gs.fuel.guildHeld, 5); // 4 + 1
});

test('createState attaches a consistent galacticSupply cache', () => {
  const state = twoGuildState();
  assert.deepEqual(checkInvariants(state, 0), [], 'fresh state passes every invariant');
  assert.equal(state.galacticSupply.resources.titanium, 15);
});

test('consistency invariant fires when the cache is tampered', () => {
  const state = twoGuildState();
  state.galacticSupply.resources.titanium = 999; // lie about the total
  const violations = checkInvariants(state, 7);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'galactic-supply-consistency');
  assert.equal(violations[0].tick, 7);
});

test('consistency invariant fires when the cache is missing entirely', () => {
  const state = twoGuildState();
  delete state.galacticSupply;
  const violations = checkInvariants(state, 0);
  assert.equal(violations.some((v) => v.rule === 'galactic-supply-consistency'), true);
});

test('tick keeps the cache consistent as production accumulates', () => {
  let state = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures: [{ id: 'v1', ownerGuildId: 'g1', type: 'mining', resourceType: 'titanium', productionRate: 5 }] }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  for (let i = 0; i < 4; i += 1) {
    state = tick(state);
    assert.deepEqual(checkInvariants(state, state.tick), [], `consistent at tick ${state.tick}`);
  }
  assert.equal(state.galacticSupply.resources.titanium, 20); // 4 * 5
});

test('the galacticSupply cache does not break determinism', () => {
  const build = () => {
    let s = createState({
      guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures: [{ id: 'v1', ownerGuildId: 'g1', type: 'mining', resourceType: 'copper', productionRate: 2 }] }],
      reserve: { reserveLevel: 7 },
      syndicate: { ledger: 0 },
    });
    for (let i = 0; i < 6; i += 1) s = tick(s);
    return s;
  };
  assert.equal(hashState(build()), hashState(build()));
});
