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
