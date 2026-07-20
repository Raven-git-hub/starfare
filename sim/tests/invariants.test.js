'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { checkInvariants, assertInvariants } = require('../invariants.js');
const { goodState, clone } = require('./fixtures.js');

// Helper: does the violation list contain a rule whose name starts with `prefix`?
function hasRule(violations, prefix) {
  return violations.some((v) => v.rule.startsWith(prefix));
}

test('a balanced state passes every invariant', () => {
  const violations = checkInvariants(goodState(), 0);
  assert.deepEqual(violations, [], 'expected no violations');
  assert.doesNotThrow(() => assertInvariants(goodState(), 0));
});

test('invariant 1: extra fuel in the reserve breaks conservation', () => {
  const s = clone(goodState());
  s.reserve.reserveLevel += 1; // fuel appeared from nowhere
  const violations = checkInvariants(s, 7);
  assert.ok(hasRule(violations, 'conservation-of-fuel'));
  assert.equal(violations[0].tick, 7, 'violation is tagged with the tick');
});

test('invariant 1: fuel in transit is counted', () => {
  const s = clone(goodState());
  // Move 5 fuel out of the reserve into a shipment: total is unchanged, so this
  // must still PASS. Proves in-transit fuel is not silently lost from the sum.
  s.reserve.reserveLevel -= 5;
  s.shipments.push({ cargo: { fuel: 5 } });
  assert.deepEqual(checkInvariants(s, 0), []);
});

test('invariant 2: minting a credit breaks conservation', () => {
  const s = clone(goodState());
  s.guilds[0].credits += 1; // no matching debit anywhere
  const violations = checkInvariants(s, 3);
  assert.ok(hasRule(violations, 'conservation-of-credits'));
});

test('invariant 2: a sanctioned move recorded in the audit passes', () => {
  const s = clone(goodState());
  // Baseline allocation: Syndicate pays g1 100 credits and records the delta.
  // Ledger drops, guild rises, expectedCreditTotal is unchanged because credits
  // only moved — nothing was minted. Must PASS.
  s.guilds[0].credits += 100;
  s.syndicate.ledger -= 100;
  assert.deepEqual(checkInvariants(s, 0), []);
});

test('invariant 3: negative influence is caught (and only that)', () => {
  const s = clone(goodState());
  s.guilds[0].influence = -1; // influence is in no conservation sum, so this
                              // isolates the non-negativity check
  const violations = checkInvariants(s, 0);
  assert.ok(hasRule(violations, 'non-negativity'));
  assert.ok(!hasRule(violations, 'conservation-of-fuel'));
  assert.ok(!hasRule(violations, 'conservation-of-credits'));
});

test('§15.2: a fractional value is caught even when it stays non-negative', () => {
  const s = clone(goodState());
  s.guilds[0].influence = 2.5; // positive, but not an integer
  const violations = checkInvariants(s, 0);
  assert.ok(hasRule(violations, 'integer credits/goods'));
  assert.ok(!hasRule(violations, 'non-negativity'));
});

test('the Syndicate ledger may go deeply negative without tripping non-negativity', () => {
  const s = clone(goodState());
  // Push the ledger far negative and match it with guild credits so credit
  // conservation still holds. The ledger's negativity must be tolerated.
  s.guilds[0].credits += 9000;
  s.syndicate.ledger -= 9000;
  const violations = checkInvariants(s, 0);
  assert.deepEqual(violations, [], 'ledger negativity is exempt from invariant 3');
});

test('the Syndicate ledger must still be an integer', () => {
  const s = clone(goodState());
  // Make ONLY the ledger fractional, keeping credit conservation intact by
  // moving expectedCreditTotal to match: 1500 + (-1500.5) = -0.5. Guild credits
  // stay integer, so the only thing wrong is the ledger's fractional value.
  s.syndicate.ledger = -1500.5;
  s.audit.expectedCreditTotal = -0.5;
  const violations = checkInvariants(s, 0);
  assert.ok(hasRule(violations, 'integer credits/goods'));
  assert.ok(!hasRule(violations, 'non-negativity'), 'ledger is still exempt from non-negativity');
  assert.ok(!hasRule(violations, 'conservation-of-credits'), 'conservation was kept intact');
});

test('assertInvariants throws loudly with the tick number', () => {
  const s = clone(goodState());
  s.reserve.reserveLevel = -100; // breaks both fuel conservation and non-negativity
  assert.throws(() => assertInvariants(s, 42), /Invariant violation at tick 42/);
});
