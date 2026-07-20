'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick, STEPS } = require('../tick.js');
const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { goodState, clone } = require('./fixtures.js');

test('tick requires state', () => {
  assert.throws(() => tick(), /state is required/);
});

test('tick rejects a non-array actions argument', () => {
  assert.throws(() => tick(goodState(), 'not-an-array'), /actions must be an array/);
});

test('tick defaults actions to an empty array', () => {
  assert.doesNotThrow(() => tick(goodState()));
});

test('tick never mutates its input state', () => {
  const before = goodState();
  const beforeSnapshot = clone(before);
  tick(before);
  assert.deepEqual(before, beforeSnapshot, 'input state must be untouched');
});

test('tick returns a new object, not the same reference', () => {
  const s = goodState();
  const next = tick(s);
  assert.notEqual(next, s);
});

test('tick increments the tick counter by exactly 1', () => {
  const s = createState({
    guilds: [{ id: 'g1', credits: 10, fuelHoard: 0 }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: -10 },
  });
  assert.equal(s.tick, 0);
  const next = tick(s);
  assert.equal(next.tick, 1);
  const nextNext = tick(next);
  assert.equal(nextNext.tick, 2);
});

test('the eight steps run in the exact §15.6 order', () => {
  assert.equal(STEPS.length, 8);
  assert.deepEqual(
    STEPS.map((fn) => fn.name),
    [
      'stepProduction',
      'stepConsumption',
      'stepPriceRecompute',
      'stepScheduledEvents',
      'stepArrivals',
      'stepBaselineAllocation',
      'stepStoryteller',
      'stepVoteClosures',
    ]
  );
});

test('a state built by createState still passes every invariant after a tick', () => {
  const s = createState({
    guilds: [
      { id: 'g1', credits: 120, fuelHoard: 0, influence: 100 },
      { id: 'g2', isBot: true, credits: 200, fuelHoard: 5, influence: 100 },
    ],
    reserve: { reserveLevel: 30 },
    syndicate: { ledger: -350 },
  });
  const next = tick(s);
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('scaffold determinism sanity check: same start, run twice, identical hash', () => {
  // NOT the Stage 2 checklist's determinism test (that needs the real walking
  // skeleton's content running to tick 50) -- this just proves the plumbing
  // itself introduces no nondeterminism (e.g. object key order, stray
  // Date.now()/Math.random() calls) before any real logic is added to it.
  const s = createState({
    guilds: [{ id: 'g1', credits: 10, fuelHoard: 0 }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: -10 },
  });
  let a = s;
  let b = s;
  for (let i = 0; i < 10; i += 1) {
    a = tick(a);
    b = tick(b);
  }
  assert.equal(hashState(a), hashState(b));
});

// --- Step 1: production ---------------------------------------------------

function oneVentureState() {
  return createState({
    guilds: [
      {
        id: 'g1',
        credits: 0,
        fuelHoard: 0,
        ventures: [{ id: 'v1', ownerGuildId: 'g1', type: 'mining', productionRate: 3 }],
      },
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
}

test('production: one tick adds productionRate to outputStockpile', () => {
  const s = oneVentureState();
  const next = tick(s);
  assert.equal(next.guilds[0].ventures[0].outputStockpile, 3);
});

test('production: five ticks accumulate 5x productionRate', () => {
  let state = oneVentureState();
  for (let i = 0; i < 5; i += 1) state = tick(state);
  assert.equal(state.guilds[0].ventures[0].outputStockpile, 15); // 5 * 3
});

test('production: updatedAtTick is stamped with the tick it happened on', () => {
  const s = oneVentureState();
  assert.equal(s.guilds[0].ventures[0].updatedAtTick, null, 'unset before any production');
  const next = tick(s);
  assert.equal(next.guilds[0].ventures[0].updatedAtTick, 0); // stamped during tick 0 -> 1's processing
  const nextNext = tick(next);
  assert.equal(nextNext.guilds[0].ventures[0].updatedAtTick, 1);
});

test('production: a guild with no ventures array is untouched, not an error', () => {
  // goodState()'s guilds have no `ventures` field at all -- invariants.js
  // already treats this as legal (ventures is optional), so tick() must too.
  assert.doesNotThrow(() => tick(goodState()));
});

test('production: multiple ventures across multiple guilds all advance independently', () => {
  const s = createState({
    guilds: [
      {
        id: 'g1',
        credits: 0,
        fuelHoard: 0,
        ventures: [
          { id: 'v1', ownerGuildId: 'g1', type: 'mining', productionRate: 2 },
          { id: 'v2', ownerGuildId: 'g1', type: 'mining', productionRate: 5 },
        ],
      },
      {
        id: 'g2',
        credits: 0,
        fuelHoard: 0,
        ventures: [{ id: 'v3', ownerGuildId: 'g2', type: 'mining', productionRate: 1 }],
      },
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  const next = tick(s);
  assert.equal(next.guilds[0].ventures[0].outputStockpile, 2);
  assert.equal(next.guilds[0].ventures[1].outputStockpile, 5);
  assert.equal(next.guilds[1].ventures[0].outputStockpile, 1);
});

test('production output still passes every invariant over several ticks', () => {
  let state = oneVentureState();
  for (let i = 0; i < 20; i += 1) {
    state = tick(state);
    assert.deepEqual(checkInvariants(state, state.tick), []);
  }
});
