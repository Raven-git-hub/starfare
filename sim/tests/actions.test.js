'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createPaySyndicateFeeAction,
  createSetProductionProfileAction,
  validateAction,
  applyAction,
  intake,
} = require('../actions.js');
const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { getGoodPolicy, getThrottlePct } = require('../profile.js');

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

// --- setProductionProfile (slice 2a-i) ------------------------------------

test('createSetProductionProfileAction requires guildId and systemId', () => {
  assert.throws(() => createSetProductionProfileAction({ systemId: 's1' }), /guildId is required/);
  assert.throws(() => createSetProductionProfileAction({ guildId: 'g1' }), /systemId is required/);
});

// A well-formed patch touching every field is accepted, applied, and reads back.
test('a valid production-profile patch stores and reads back', () => {
  const s = twoGuildState();
  const action = createSetProductionProfileAction({
    guildId: 'g1',
    systemId: 'sys_0002',
    goods: {
      titanium: { order: ['downstream', 'stockpile', 'syndicate'], downstreamPct: 40, reserveLevel: 250 },
    },
    throttles: { refinery: 30 },
  });
  assert.deepEqual(validateAction(s, action), { valid: true });
  const next = applyAction(s, action);
  assert.deepEqual(getGoodPolicy(next.guilds[0], 'sys_0002', 'titanium'), {
    order: ['downstream', 'stockpile', 'syndicate'],
    downstreamPct: 40,
    reserveLevel: 250,
  });
  assert.equal(getThrottlePct(next.guilds[0], 'sys_0002', 'refinery'), 30);
  // Untouched goods/throttles still read their defaults.
  assert.equal(getThrottlePct(next.guilds[0], 'sys_0002', 'other'), 100);
});

// Each malformed field is rejected with a reason.
function rejects(action, re) {
  const result = validateAction(twoGuildState(), action);
  assert.equal(result.valid, false);
  assert.match(result.reason, re);
}

test('validateAction rejects an unknown guild', () => {
  rejects(createSetProductionProfileAction({ guildId: 'ghost', systemId: 's1' }), /no guild with id/);
});

test('validateAction rejects a non-string / empty systemId', () => {
  rejects(createSetProductionProfileAction({ guildId: 'g1', systemId: '' }), /systemId must be a non-empty string/);
});

test('validateAction rejects an unknown good key', () => {
  rejects(
    createSetProductionProfileAction({ guildId: 'g1', systemId: 's1', goods: { not_a_good: { downstreamPct: 50 } } }),
    /is not a known stockpile good/,
  );
});

test('validateAction rejects deuterium_fuel as a good key (not a stockpile good)', () => {
  rejects(
    createSetProductionProfileAction({ guildId: 'g1', systemId: 's1', goods: { deuterium_fuel: { downstreamPct: 50 } } }),
    /is not a known stockpile good/,
  );
});

test('validateAction rejects a bad order (not a permutation of the three forks)', () => {
  rejects(
    createSetProductionProfileAction({ guildId: 'g1', systemId: 's1', goods: { titanium: { order: ['downstream', 'downstream', 'stockpile'] } } }),
    /must be a permutation/,
  );
  rejects(
    createSetProductionProfileAction({ guildId: 'g1', systemId: 's1', goods: { titanium: { order: ['downstream', 'stockpile'] } } }),
    /must be a permutation/,
  );
});

test('validateAction rejects downstreamPct out of range or non-integer', () => {
  rejects(
    createSetProductionProfileAction({ guildId: 'g1', systemId: 's1', goods: { titanium: { downstreamPct: 101 } } }),
    /downstreamPct.*0\.\.100/,
  );
  rejects(
    createSetProductionProfileAction({ guildId: 'g1', systemId: 's1', goods: { titanium: { downstreamPct: 50.5 } } }),
    /downstreamPct.*0\.\.100/,
  );
});

test('validateAction rejects a negative or non-integer reserveLevel (§5 one-pot, Slice A)', () => {
  rejects(
    createSetProductionProfileAction({ guildId: 'g1', systemId: 's1', goods: { titanium: { reserveLevel: -1 } } }),
    /reserveLevel.*non-negative integer/,
  );
  rejects(
    createSetProductionProfileAction({ guildId: 'g1', systemId: 's1', goods: { titanium: { reserveLevel: 5.5 } } }),
    /reserveLevel.*non-negative integer/,
  );
});

test('a valid reserveLevel stores and reads back through getGoodPolicy', () => {
  const s = twoGuildState();
  const action = createSetProductionProfileAction({
    guildId: 'g1', systemId: 'sys_0002', goods: { titanium: { reserveLevel: 40 } },
  });
  assert.deepEqual(validateAction(s, action), { valid: true });
  const next = applyAction(s, action);
  assert.equal(getGoodPolicy(next.guilds[0], 'sys_0002', 'titanium').reserveLevel, 40);
});

// --- the §5 Slice B Syndicate send control `syndicate {mode, value}` -----------

test('validateAction rejects a bad syndicate control (mode / value / shape)', () => {
  rejects(
    createSetProductionProfileAction({ guildId: 'g1', systemId: 's1', goods: { titanium: { syndicate: { mode: 'nope', value: 5 } } } }),
    /syndicate\.mode.*absolute.*percent/,
  );
  rejects(
    createSetProductionProfileAction({ guildId: 'g1', systemId: 's1', goods: { titanium: { syndicate: { mode: 'absolute', value: -1 } } } }),
    /syndicate\.value.*non-negative integer/,
  );
  rejects(
    createSetProductionProfileAction({ guildId: 'g1', systemId: 's1', goods: { titanium: { syndicate: { mode: 'percent', value: 2.5 } } } }),
    /syndicate\.value.*non-negative integer/,
  );
  rejects(
    createSetProductionProfileAction({ guildId: 'g1', systemId: 's1', goods: { titanium: { syndicate: [1, 2] } } }),
    /syndicate for good.*must be an object/,
  );
});

test('a valid syndicate send control stores and reads back through getGoodPolicy', () => {
  const s = twoGuildState();
  // percent > 100 is legal (it just means "send all fresh, ASAP" — §5).
  const action = createSetProductionProfileAction({
    guildId: 'g1', systemId: 'sys_0002', goods: { titanium: { syndicate: { mode: 'percent', value: 150 } } },
  });
  assert.deepEqual(validateAction(s, action), { valid: true });
  const next = applyAction(s, action);
  assert.deepEqual(getGoodPolicy(next.guilds[0], 'sys_0002', 'titanium').syndicate, { mode: 'percent', value: 150 });
  // A good with no syndicate control set carries no `syndicate` key (paced default).
  assert.equal('syndicate' in getGoodPolicy(next.guilds[0], 'sys_0002', 'lead'), false);
});

test('validateAction rejects a non-integer throttle', () => {
  rejects(
    createSetProductionProfileAction({ guildId: 'g1', systemId: 's1', throttles: { refinery: 33.3 } }),
    /throttle.*0\.\.100/,
  );
});

// The DELIBERATE non-checks (§5, §15.4): advisory intent stored ahead of / after
// the ventures it references is legal. Neither is a referential error.
test('validateAction ACCEPTS a throttle naming a not-yet-existing venture (advisory)', () => {
  const action = createSetProductionProfileAction({ guildId: 'g1', systemId: 's1', throttles: { 'venture-that-does-not-exist': 40 } });
  assert.deepEqual(validateAction(twoGuildState(), action), { valid: true });
});

test('validateAction ACCEPTS a policy for a good with no current producer (advisory)', () => {
  const action = createSetProductionProfileAction({ guildId: 'g1', systemId: 's1', goods: { gold: { downstreamPct: 20 } } });
  assert.deepEqual(validateAction(twoGuildState(), action), { valid: true });
});

test('a production-profile action leaves state passing every invariant', () => {
  const s = twoGuildState();
  const { state: next } = intake(s, [
    createSetProductionProfileAction({ guildId: 'g1', systemId: 'sys_0002', goods: { titanium: { downstreamPct: 50 } }, throttles: { v1: 25 } }),
  ]);
  assert.deepEqual(checkInvariants(next, next.tick), []);
});
