'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createPaySyndicateFeeAction,
  createSetProductionProfileAction,
  createSetSyndicateCommitmentAction,
  createSetWindowNAction,
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

// The clear-path: a field sent null is ACCEPTED (not a validation error) and clears the
// stored key, so the good reverts to its default — the "return to Paced" round-trip.
test('setProductionProfile accepts syndicate: null and clears back to the paced default', () => {
  const s = twoGuildState();
  const set = createSetProductionProfileAction({
    guildId: 'g1', systemId: 'sys_0002', goods: { titanium: { syndicate: { mode: 'absolute', value: 4 } } },
  });
  const afterSet = applyAction(s, set);
  assert.deepEqual(getGoodPolicy(afterSet.guilds[0], 'sys_0002', 'titanium').syndicate, { mode: 'absolute', value: 4 });

  // null must PASS validation (it is the clear instruction, not a malformed control).
  const clear = createSetProductionProfileAction({
    guildId: 'g1', systemId: 'sys_0002', goods: { titanium: { syndicate: null } },
  });
  assert.deepEqual(validateAction(afterSet, clear), { valid: true });
  const afterClear = applyAction(afterSet, clear);
  assert.equal('syndicate' in getGoodPolicy(afterClear.guilds[0], 'sys_0002', 'titanium'), false,
    'the send control reverts to the paced required-rate default (key gone)');
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

// --- setSyndicateCommitment / setWindowN (commitment-injection dev scaffold) ---
// The two throwaway dev-scaffold actions (design.md §15.4 "Scaffold 11-08-26", §5).
// A state carrying a mine (resourceType) and a refinery (no resourceType) so both
// the accept and the fail-loud paths have real ventures to target.

const SYS = 'sysA';
function ventureState() {
  return createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      ventures: [
        { id: 'mine_1', ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: 'titanium', productionRate: 10 },
        { id: 'ref_1', ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId: 'titanium_alloy', productionRate: 2 },
      ],
    }, {
      id: 'g2', credits: 0, fuelHoard: 0,
      ventures: [{ id: 'mine_2', ownerGuildId: 'g2', type: 'mining', systemId: SYS, resourceType: 'carbon_products', productionRate: 10 }],
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
}
const ventureById = (state, guildIdx, ventureId) => state.guilds[guildIdx].ventures.find((v) => v.id === ventureId);

test('createSetSyndicateCommitmentAction requires guildId, ventureId, commitment', () => {
  assert.throws(() => createSetSyndicateCommitmentAction({ ventureId: 'm', commitment: 1 }), /guildId is required/);
  assert.throws(() => createSetSyndicateCommitmentAction({ guildId: 'g1', commitment: 1 }), /ventureId is required/);
  assert.throws(() => createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 'm' }), /commitment is required/);
  assert.deepEqual(createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 'mine_1', commitment: 8 }), {
    type: 'setSyndicateCommitment', guildId: 'g1', ventureId: 'mine_1', commitment: 8,
  });
});

test('setSyndicateCommitment sets the venture field, and 0 clears it back to unlicensed', () => {
  const s = ventureState();
  const set = createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 'mine_1', commitment: 8 });
  assert.deepEqual(validateAction(s, set), { valid: true });
  const after = applyAction(s, set);
  assert.equal(ventureById(after, 0, 'mine_1').syndicateCommitment, 8);
  // input untouched (applyAction never mutates its argument)
  assert.equal(ventureById(s, 0, 'mine_1').syndicateCommitment, 0);
  // 0 clears back to unlicensed — always allowed.
  const clear = createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 'mine_1', commitment: 0 });
  assert.deepEqual(validateAction(after, clear), { valid: true });
  assert.equal(ventureById(applyAction(after, clear), 0, 'mine_1').syndicateCommitment, 0);
});

test('setSyndicateCommitment does NOT set committedFromTick (the fraction==1 tripwire stays green)', () => {
  const s = ventureState();
  const after = applyAction(s, createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 'mine_1', commitment: 8 }));
  assert.equal('committedFromTick' in ventureById(after, 0, 'mine_1'), false,
    'the scaffold must never stamp committedFromTick — that keeps windowFraction == 1');
});

// The scaffold ACCEPTS a factory (factory-commitment slice, 28-08-26). It used to refuse
// one — the §5 accrual summed commitment over mines only, so a factory's number would
// have sat there inert — and the accrual is producer-general now, keyed on the good the
// venture produces (its recipe's output for a factory).
test('setSyndicateCommitment ACCEPTS a factory — its commitment lands on the recipe output', () => {
  const s = ventureState();
  const act = createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 'ref_1', commitment: 5 });
  assert.deepEqual(validateAction(s, act), { valid: true });
  const { state: next, results } = intake(s, [act]);
  assert.equal(results[0].accepted, true);
  assert.equal(ventureById(next, 0, 'ref_1').syndicateCommitment, 5);
  // Still a scaffold: it stamps no join tick, so the factory commits for the whole window.
  assert.equal('committedFromTick' in ventureById(next, 0, 'ref_1'), false);
});

test('setSyndicateCommitment REJECTS a venture that produces nothing identifiable (fail loud, state unchanged)', () => {
  // A dangling recipeId resolves to no output good, so a commitment on it could never
  // contribute to any `Q` — refused rather than stored inert.
  const s = ventureState();
  const withDangler = structuredClone(s);
  withDangler.guilds[0].ventures.push({
    id: 'ref_x', ownerGuildId: 'g1', type: 'refining', systemId: 'sysA',
    recipeId: 'no_such_recipe', productionRate: 1,
  });
  const bad = createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 'ref_x', commitment: 5 });
  const r = validateAction(withDangler, bad);
  assert.equal(r.valid, false);
  assert.match(r.reason, /produces no identifiable good/);
  const { state: next, results } = intake(withDangler, [bad]);
  assert.equal(results[0].accepted, false);
  assert.equal(ventureById(next, 0, 'ref_x').syndicateCommitment, undefined);
});

test('setSyndicateCommitment ACCEPTS commitment 0 on a non-resourceType venture (clearing is always legal)', () => {
  const s = ventureState();
  assert.deepEqual(validateAction(s, createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 'ref_1', commitment: 0 })), { valid: true });
});

test('setSyndicateCommitment rejects a negative or non-integer commitment', () => {
  const s = ventureState();
  assert.equal(validateAction(s, createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 'mine_1', commitment: -1 })).valid, false);
  assert.equal(validateAction(s, createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 'mine_1', commitment: 2.5 })).valid, false);
});

test('setSyndicateCommitment rejects an unknown guild, and a venture not owned by the guild', () => {
  const s = ventureState();
  assert.match(validateAction(s, createSetSyndicateCommitmentAction({ guildId: 'ghost', ventureId: 'mine_1', commitment: 1 })).reason, /no guild with id/);
  // mine_2 exists but belongs to g2, not g1 — must be refused for g1.
  assert.match(validateAction(s, createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 'mine_2', commitment: 1 })).reason, /has no venture with id/);
  // an id that names no venture at all.
  assert.match(validateAction(s, createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 'nope', commitment: 1 })).reason, /has no venture with id/);
});

test('a setSyndicateCommitment action leaves state passing every invariant', () => {
  const s = ventureState();
  const { state: next } = intake(s, [createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 'mine_1', commitment: 8 })]);
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('createSetWindowNAction requires windowN and carries no guildId (the first state-scoped action)', () => {
  assert.throws(() => createSetWindowNAction({}), /windowN is required/);
  const a = createSetWindowNAction({ windowN: 60 });
  assert.deepEqual(a, { type: 'setWindowN', windowN: 60 });
  assert.equal('guildId' in a, false);
});

test('setWindowN sets state.windowN at tick 0', () => {
  const s = ventureState();
  assert.equal(s.windowN, undefined, 'no window length until one is set');
  const set = createSetWindowNAction({ windowN: 60 }); // 60 is the SCENARIO value, never baked into the engine
  assert.deepEqual(validateAction(s, set), { valid: true });
  const after = applyAction(s, set);
  assert.equal(after.windowN, 60);
  // input untouched
  assert.equal(s.windowN, undefined);
});

test('setWindowN rejects windowN < 1 or non-integer', () => {
  const s = ventureState();
  assert.equal(validateAction(s, createSetWindowNAction({ windowN: 0 })).valid, false);
  assert.equal(validateAction(s, createSetWindowNAction({ windowN: -3 })).valid, false);
  assert.equal(validateAction(s, createSetWindowNAction({ windowN: 4.5 })).valid, false);
});

test('setWindowN rejects a set once the run has started (tick > 0), leaving state unchanged', () => {
  const s = ventureState();
  const ticked = { ...s, tick: 1 }; // pretend the run advanced
  const r = validateAction(ticked, createSetWindowNAction({ windowN: 60 }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /setup-only knob/);
  const { state: next, results } = intake(ticked, [createSetWindowNAction({ windowN: 60 })]);
  assert.equal(results[0].accepted, false);
  assert.equal(next.windowN, undefined, 'a rejected setWindowN leaves state.windowN untouched');
});
