'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createGuild,
  createVenture,
  createReserve,
  createSyndicate,
  createState,
} = require('../state.js');
const { checkInvariants } = require('../invariants.js');

// A minimal two-guild scenario — NOT the real walking-skeleton numbers
// (those are a future scenarios/ concern), just enough to prove createState
// assembles a valid state from arbitrary scenario data.
function twoGuildScenario() {
  return {
    guilds: [
      {
        id: 'g1',
        credits: 120,
        fuelHoard: 0,
        influence: 100,
        ventures: [
          { id: 'v1', ownerGuildId: 'g1', type: 'mining', productionRate: 3 },
        ],
      },
      {
        id: 'g2',
        isBot: true,
        credits: 200,
        fuelHoard: 5,
        influence: 100,
      },
    ],
    reserve: { reserveLevel: 30 },
    syndicate: { ledger: -350 }, // balances: (120+200) + (-350) = -30, see below
  };
}

test('createGuild fills in defaults and nests ventures', () => {
  const g = createGuild({ id: 'g1', credits: 10, fuelHoard: 0 });
  assert.equal(g.id, 'g1');
  assert.equal(g.name, 'g1', 'name defaults to id when not given');
  assert.equal(g.isBot, false);
  assert.equal(g.influence, 0);
  assert.deepEqual(g.ventures, []);
  assert.deepEqual(g.lifetimeProduced, {});
});

test('createGuild requires id, credits, and fuelHoard', () => {
  assert.throws(() => createGuild({ credits: 1, fuelHoard: 0 }), /id is required/);
  assert.throws(() => createGuild({ id: 'g1', fuelHoard: 0 }), /credits is required/);
  assert.throws(() => createGuild({ id: 'g1', credits: 1 }), /fuelHoard is required/);
});

test('createVenture fills in defaults', () => {
  const v = createVenture({ id: 'v1', ownerGuildId: 'g1', type: 'mining' });
  assert.equal(v.productionRate, 0);
  assert.deepEqual(v.inputStockpiles, {});
  assert.equal(v.outputStockpile, 0);
});

test('createReserve and createSyndicate require their one field', () => {
  assert.throws(() => createReserve({}), /reserveLevel is required/);
  assert.throws(() => createSyndicate({}), /ledger is required/);
  assert.deepEqual(createReserve({ reserveLevel: 30 }), { reserveLevel: 30 });
  assert.deepEqual(createSyndicate({ ledger: -30 }), { ledger: -30 });
});

test('createState assembles guilds, ventures, reserve, and syndicate', () => {
  const state = createState(twoGuildScenario());
  assert.equal(state.tick, 0);
  assert.equal(state.guilds.length, 2);
  assert.equal(state.guilds[0].ventures[0].id, 'v1');
  assert.equal(state.reserve.reserveLevel, 30);
  assert.equal(state.syndicate.ledger, -350);
  assert.deepEqual(state.shipments, []);
});

test('createState computes an audit block that passes every invariant', () => {
  const state = createState(twoGuildScenario());
  const violations = checkInvariants(state, 0);
  assert.deepEqual(violations, [], 'expected no violations');
});

test('createState computes audit correctly regardless of scenario numbers', () => {
  // A different scenario, with different numbers, should STILL pass —
  // proving audit is computed from what was assembled, not asserted by hand.
  const scenario = {
    guilds: [
      { id: 'a', credits: 999, fuelHoard: 12 },
      { id: 'b', credits: 1, fuelHoard: 0 },
    ],
    reserve: { reserveLevel: 88 },
    syndicate: { ledger: -1000 },
  };
  const state = createState(scenario);
  assert.deepEqual(checkInvariants(state, 0), []);
});

test('createState rejects a missing or empty guild list', () => {
  assert.throws(() => createState({ reserve: {}, syndicate: {} }), /guilds must be a non-empty array/);
  assert.throws(
    () => createState({ guilds: [], reserve: {}, syndicate: {} }),
    /guilds must be a non-empty array/
  );
});
