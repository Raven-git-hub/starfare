'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createGuild,
  createVenture,
  createVehicle,
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

test('createGuild fills in defaults and nests ventures and vehicles', () => {
  const g = createGuild({ id: 'g1', credits: 10, fuelHoard: 0 });
  assert.equal(g.id, 'g1');
  assert.equal(g.name, 'g1', 'name defaults to id when not given');
  assert.equal(g.isBot, false);
  assert.equal(g.influence, 0);
  assert.deepEqual(g.ventures, []);
  assert.deepEqual(g.vehicles, []);
  assert.deepEqual(g.lifetimeProduced, {});
  assert.deepEqual(g.stockpiles, {}, 'stockpiles default to empty');
  assert.deepEqual(g.productionProfile, {}, 'productionProfile defaults to empty');
});

test('createGuild copies productionProfile so a caller cannot alias into state', () => {
  const supplied = { sys_0002: { goods: { titanium: { order: ['downstream', 'stockpile', 'syndicate'] } }, throttles: { v1: 25 } } };
  const g = createGuild({ id: 'g1', credits: 0, fuelHoard: 0, productionProfile: supplied });
  // Mutating the caller's object after construction must NOT reach into the guild.
  supplied.sys_0002.throttles.v1 = 999;
  supplied.sys_0002.goods.titanium.order.push('junk');
  assert.equal(g.productionProfile.sys_0002.throttles.v1, 25);
  assert.deepEqual(g.productionProfile.sys_0002.goods.titanium.order, ['downstream', 'stockpile', 'syndicate']);
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
  assert.equal(v.resourceType, null, 'resourceType defaults to null (mines nothing until set)');
  assert.equal(v.outputStockpile, undefined, 'the typeless outputStockpile scalar was retired');
  // syndicateCommitment is the RESERVED placeholder (§15.4, §5): engine-owned and
  // 0/unlicensed by default, since no licence system exists yet. It is defaulted
  // (never operator-supplied) precisely so the Production view reads a real field.
  assert.equal(v.syndicateCommitment, 0, 'syndicateCommitment defaults to 0 (unlicensed)');
  assert.equal('committedFromTick' in v, false, 'and carries no join tick — the omit-when-absent discipline');
});

test('createVenture round-trips committedFromTick, the pro-rate term', () => {
  // It was silently DROPPED: every other licence field was destructured and this one
  // was not, so a scenario (or a persisted state) handing one in lost it and the
  // venture reverted to owing a FULL window (§5's join ruling, sim/windows.js).
  const v = createVenture({
    id: 'v1', ownerGuildId: 'g1', type: 'mining', syndicateCommitment: 20, committedFromTick: 7,
  });
  assert.equal(v.committedFromTick, 7, 'the join tick survives assembly');
  // Omitted when absent, so an unlicensed galaxy's bytes are untouched — and a 0 is
  // carried through to the tick's tripwire rather than swallowed as "absent".
  assert.equal('committedFromTick' in createVenture({ id: 'v2', ownerGuildId: 'g1', type: 'mining', committedFromTick: null }), false);
  assert.equal(createVenture({ id: 'v3', ownerGuildId: 'g1', type: 'mining', committedFromTick: 0 }).committedFromTick, 0);
});

test('createVehicle defaults to a light transport, idle, with no fuel/speed/etc. invented', () => {
  const v = createVehicle({
    id: 'ship1',
    ownerGuildId: 'g1',
    speed: 2,
    capacity: 10,
    defenseRating: 1,
    fuelCostToRun: 4,
  });
  assert.equal(v.class, 'lightTransport');
  assert.equal(v.status, 'idle');
  assert.equal(v.speed, 2);
  assert.equal(v.capacity, 10);
  assert.equal(v.defenseRating, 1);
  assert.equal(v.fuelCostToRun, 4);
  assert.equal(v.updatedAtTick, null);
});

test('createVehicle requires id, ownerGuildId, speed, capacity, defenseRating, and fuelCostToRun', () => {
  const full = { id: 'ship1', ownerGuildId: 'g1', speed: 2, capacity: 10, defenseRating: 1, fuelCostToRun: 4 };
  assert.throws(() => createVehicle({ ...full, id: undefined }), /id is required/);
  assert.throws(() => createVehicle({ ...full, ownerGuildId: undefined }), /ownerGuildId is required/);
  assert.throws(() => createVehicle({ ...full, speed: undefined }), /speed is required/);
  assert.throws(() => createVehicle({ ...full, capacity: undefined }), /capacity is required/);
  assert.throws(() => createVehicle({ ...full, defenseRating: undefined }), /defenseRating is required/);
  assert.throws(() => createVehicle({ ...full, fuelCostToRun: undefined }), /fuelCostToRun is required/);
  assert.doesNotThrow(() => createVehicle(full));
});

test('createVehicle: class and status can be overridden', () => {
  const v = createVehicle({
    id: 'ship1',
    ownerGuildId: 'g1',
    class: 'mediumTransport',
    speed: 1,
    capacity: 20,
    defenseRating: 2,
    fuelCostToRun: 8,
    status: 'inTransit',
  });
  assert.equal(v.class, 'mediumTransport');
  assert.equal(v.status, 'inTransit');
});

test('createGuild nests vehicles the same way it nests ventures', () => {
  const g = createGuild({
    id: 'g1',
    credits: 10,
    fuelHoard: 0,
    vehicles: [{ id: 'ship1', ownerGuildId: 'g1', speed: 2, capacity: 10, defenseRating: 1, fuelCostToRun: 4 }],
  });
  assert.equal(g.vehicles.length, 1);
  assert.equal(g.vehicles[0].id, 'ship1');
  assert.equal(g.vehicles[0].class, 'lightTransport');
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

test('createState assembles a scenario with a vehicle and still passes every invariant', () => {
  const scenario = {
    guilds: [
      {
        id: 'g1',
        credits: 120,
        fuelHoard: 0,
        vehicles: [
          { id: 'ship1', ownerGuildId: 'g1', speed: 2, capacity: 10, defenseRating: 1, fuelCostToRun: 4 },
        ],
      },
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: -120 },
  };
  const state = createState(scenario);
  assert.equal(state.guilds[0].vehicles[0].id, 'ship1');
  assert.deepEqual(checkInvariants(state, 0), []);
});

test('createState requires guilds to be an array, but allows an empty roster', () => {
  // Missing or non-array guilds is still an error...
  assert.throws(() => createState({ reserve: {}, syndicate: {} }), /guilds must be an array/);
  assert.throws(
    () => createState({ guilds: 'nope', reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 } }),
    /guilds must be an array/
  );
  // ...but an EMPTY roster is now legal: it is the guild-less zero-state a fresh
  // server boots into and waits in until the owner founds the first guild.
  const zero = createState({ guilds: [], reserve: { reserveLevel: 30 }, syndicate: { ledger: 0 } });
  assert.equal(zero.guilds.length, 0);
  assert.deepEqual(checkInvariants(zero, 0), []);
});
