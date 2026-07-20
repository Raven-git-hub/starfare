'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createPaySyndicateFeeAction,
  validateAction,
  applyAction,
  intake,
} = require('../actions.js');
const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');

function twoGuildState() {
  return createState({
    guilds: [
      { id: 'g1', credits: 100, fuelHoard: 0 },
      { id: 'g2', credits: 50, fuelHoard: 0 },
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: -150 },
  });
}

test('createPaySyndicateFeeAction requires guildId and amount', () => {
  assert.throws(() => createPaySyndicateFeeAction({ amount: 10 }), /guildId is required/);
  assert.throws(() => createPaySyndicateFeeAction({ guildId: 'g1' }), /amount is required/);
  assert.deepEqual(createPaySyndicateFeeAction({ guildId: 'g1', amount: 10 }), {
    type: 'paySyndicateFee',
    guildId: 'g1',
    amount: 10,
  });
});

test('validateAction accepts a guild paying what it can afford', () => {
  const s = twoGuildState();
  const action = createPaySyndicateFeeAction({ guildId: 'g1', amount: 80 });
  assert.deepEqual(validateAction(s, action), { valid: true });
});

test('validateAction rejects an unknown guild', () => {
  const s = twoGuildState();
  const action = createPaySyndicateFeeAction({ guildId: 'ghost', amount: 10 });
  const result = validateAction(s, action);
  assert.equal(result.valid, false);
  assert.match(result.reason, /no guild with id/);
});

test('validateAction rejects a non-integer or non-positive amount', () => {
  const s = twoGuildState();
  assert.equal(validateAction(s, createPaySyndicateFeeAction({ guildId: 'g1', amount: 1.5 })).valid, false);
  assert.equal(validateAction(s, createPaySyndicateFeeAction({ guildId: 'g1', amount: 0 })).valid, false);
  assert.equal(validateAction(s, createPaySyndicateFeeAction({ guildId: 'g1', amount: -5 })).valid, false);
});

test('validateAction rejects insufficient funds', () => {
  const s = twoGuildState();
  const action = createPaySyndicateFeeAction({ guildId: 'g2', amount: 51 });
  const result = validateAction(s, action);
  assert.equal(result.valid, false);
  assert.match(result.reason, /cannot pay/);
});

test('validateAction rejects an unknown action type', () => {
  const s = twoGuildState();
  const result = validateAction(s, { type: 'doSomethingElse' });
  assert.equal(result.valid, false);
  assert.match(result.reason, /unknown action type/);
});

test('applyAction moves credits from the guild to the Syndicate ledger', () => {
  const s = twoGuildState();
  const action = createPaySyndicateFeeAction({ guildId: 'g1', amount: 80 });
  const next = applyAction(s, action);
  assert.equal(next.guilds[0].credits, 20);
  assert.equal(next.syndicate.ledger, -150 + 80);
  // input untouched
  assert.equal(s.guilds[0].credits, 100);
});

test('§15.6\'s own example: three "spend 80" orders on 100 credits -- only the first is accepted', () => {
  const s = twoGuildState(); // g1 starts with 100 credits
  const actions = [
    createPaySyndicateFeeAction({ guildId: 'g1', amount: 80 }),
    createPaySyndicateFeeAction({ guildId: 'g1', amount: 80 }),
    createPaySyndicateFeeAction({ guildId: 'g1', amount: 80 }),
  ];

  const { state: next, results } = intake(s, actions);

  assert.deepEqual(
    results.map((r) => r.accepted),
    [true, false, false],
    'only the first order should be accepted, because the second and third are validated against the ALREADY-DEBITED balance'
  );
  assert.match(results[1].reason, /cannot pay/);
  assert.match(results[2].reason, /cannot pay/);

  // g1 paid exactly once: 100 - 80 = 20. If validation had (bugged-ly) used
  // one stale snapshot for all three, g1 would incorrectly end at -140.
  assert.equal(next.guilds[0].credits, 20);
  assert.equal(next.syndicate.ledger, -150 + 80);
});

test('intake never mutates the input state', () => {
  const s = twoGuildState();
  const before = JSON.parse(JSON.stringify(s));
  intake(s, [createPaySyndicateFeeAction({ guildId: 'g1', amount: 80 })]);
  assert.deepEqual(s, before);
});

test('intake processes independent guilds correctly in the same batch', () => {
  const s = twoGuildState();
  const actions = [
    createPaySyndicateFeeAction({ guildId: 'g1', amount: 30 }),
    createPaySyndicateFeeAction({ guildId: 'g2', amount: 20 }),
  ];
  const { state: next, results } = intake(s, actions);
  assert.deepEqual(results.map((r) => r.accepted), [true, true]);
  assert.equal(next.guilds[0].credits, 70);
  assert.equal(next.guilds[1].credits, 30);
  assert.equal(next.syndicate.ledger, -150 + 30 + 20);
});

test('a rejected action leaves state untouched for that step', () => {
  const s = twoGuildState();
  const actions = [
    createPaySyndicateFeeAction({ guildId: 'g2', amount: 999 }), // rejected
    createPaySyndicateFeeAction({ guildId: 'g1', amount: 10 }), // accepted
  ];
  const { state: next, results } = intake(s, actions);
  assert.deepEqual(results.map((r) => r.accepted), [false, true]);
  assert.equal(next.guilds[1].credits, 50, 'g2 untouched by its own rejected action');
  assert.equal(next.guilds[0].credits, 90);
});

test('state produced by intake still passes every invariant', () => {
  const s = twoGuildState();
  const actions = [
    createPaySyndicateFeeAction({ guildId: 'g1', amount: 80 }),
    createPaySyndicateFeeAction({ guildId: 'g1', amount: 80 }), // rejected
    createPaySyndicateFeeAction({ guildId: 'g2', amount: 50 }),
  ];
  const { state: next } = intake(s, actions);
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('intake requires state and an array of actions', () => {
  assert.throws(() => intake(undefined, []), /state is required/);
  assert.throws(() => intake(twoGuildState(), 'nope'), /actions must be an array/);
});
